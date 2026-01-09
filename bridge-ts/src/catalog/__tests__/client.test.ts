/**
 * Unit tests for CatalogClient
 * 
 * Tests the IPC communication with the catalog worker process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.fork
const mockWorkerProcess = {
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  kill: vi.fn(),
  stdout: {
    on: vi.fn(),
  },
  stderr: {
    on: vi.fn(),
  },
};

vi.mock('child_process', () => ({
  fork: vi.fn(() => mockWorkerProcess),
}));

vi.mock('../../native-messaging.js', () => ({
  log: vi.fn(),
}));

// Mock database
vi.mock('../database.js', () => ({
  getCatalogDb: vi.fn(() => ({
    getAllServers: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    getProviderStatus: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ total: 0, removed: 0, bySource: {} }),
    isCacheStale: vi.fn().mockReturnValue(false),
    getLastFetchTime: vi.fn().mockReturnValue(Date.now()),
    close: vi.fn(),
  })),
}));

// Import after mocking
import { CatalogClient } from '../client.js';

describe('CatalogClient', () => {
  let client: CatalogClient;
  let messageHandler: ((message: unknown) => void) | null = null;
  let exitHandler: ((code: number | null) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    exitHandler = null;

    // Capture message and exit handlers
    mockWorkerProcess.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        messageHandler = handler as (message: unknown) => void;
      } else if (event === 'exit') {
        exitHandler = handler as (code: number | null) => void;
      }
      return mockWorkerProcess;
    });

    mockWorkerProcess.off.mockReturnValue(mockWorkerProcess);

    // Create client with autoStart: false to control worker lifecycle in tests
    client = new CatalogClient({ autoStart: false });
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create client in stopped state when autoStart is false', () => {
      expect(client).toBeDefined();
      expect(client.getWorkerStatus()).toBe('stopped');
    });

    it('should auto-start worker when autoStart is true', async () => {
      const { fork } = await import('child_process');
      
      // Create with autoStart: true
      const autoClient = new CatalogClient({ autoStart: true });
      
      expect(fork).toHaveBeenCalled();
      expect(autoClient.getWorkerStatus()).not.toBe('stopped');
      
      autoClient.close();
    });
  });

  describe('startWorker', () => {
    it('should fork a new process with --catalog-worker flag', async () => {
      const { fork } = await import('child_process');

      client.startWorker();

      expect(fork).toHaveBeenCalledWith(
        process.argv[1],
        ['--catalog-worker'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: expect.objectContaining({
            HARBOR_CATALOG_WORKER: '0',
          }),
        })
      );
      expect(client.getWorkerStatus()).toBe('running');
    });

    it('should not fork if already running', async () => {
      const { fork } = await import('child_process');

      // First start
      client.startWorker();

      // Second start should be a no-op
      client.startWorker();

      expect(fork).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopWorker', () => {
    beforeEach(() => {
      client.startWorker();
    });

    it('should send shutdown and schedule kill', () => {
      client.stopWorker();

      expect(mockWorkerProcess.send).toHaveBeenCalledWith({ type: 'shutdown' });
      expect(client.getWorkerStatus()).toBe('stopped');
    });

    it('should be idempotent', () => {
      client.stopWorker();
      client.stopWorker();
      // Should not throw
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      client.startWorker();
    });

    it('should send refresh command and return stats', async () => {
      const refreshPromise = client.refresh();

      setTimeout(() => {
        messageHandler?.({
          id: '1',
          type: 'refresh',
          success: true,
          data: {
            changes: { length: 5 },
            serverCount: 100,
          },
        });
      }, 10);

      const result = await refreshPromise;

      expect(result.changes).toBe(5);
      expect(result.serverCount).toBe(100);
      expect(mockWorkerProcess.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'refresh' })
      );
    });

    it('should reject on refresh failure', async () => {
      const refreshPromise = client.refresh();

      setTimeout(() => {
        messageHandler?.({
          id: '1',
          type: 'refresh',
          success: false,
          error: 'Network error',
        });
      }, 10);

      await expect(refreshPromise).rejects.toThrow('Network error');
    });
  });

  describe('searchServers', () => {
    it('should search locally in database', () => {
      const result = client.searchServers('file');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getServer', () => {
    it('should get server by id from database', () => {
      const result = client.getServer('filesystem');
      // Returns undefined since mock returns empty array
      expect(result).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should get catalog statistics from database', () => {
      const result = client.getStats();
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('removed');
      expect(result).toHaveProperty('bySource');
    });
  });

  describe('worker crash handling', () => {
    it('should set status to error on non-zero exit', () => {
      client.startWorker();
      expect(client.getWorkerStatus()).toBe('running');

      // Simulate crash
      exitHandler?.(1);

      expect(client.getWorkerStatus()).toBe('error');
    });

    it('should set status to stopped on clean exit', () => {
      client.startWorker();
      exitHandler?.(0);
      expect(client.getWorkerStatus()).toBe('stopped');
    });

    it('should reject pending requests on crash', async () => {
      client.startWorker();

      const refreshPromise = client.refresh();

      // Crash before response
      setTimeout(() => {
        exitHandler?.(1);
      }, 5);

      await expect(refreshPromise).rejects.toThrow('Worker exited');
    });
  });

  describe('pkg compatibility', () => {
    it('should use process.argv[1] (script path) for forking', async () => {
      const { fork } = await import('child_process');

      client.startWorker();

      // The first argument to fork should be process.argv[1] (the script path)
      // fork(modulePath, args) - modulePath is what fork() actually runs
      expect(fork).toHaveBeenCalledWith(
        process.argv[1],
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('should pass --catalog-worker flag', async () => {
      const { fork } = await import('child_process');

      client.startWorker();

      const args = (fork as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args).toContain('--catalog-worker');
    });
  });

  describe('IPC message correlation', () => {
    beforeEach(() => {
      client.startWorker();
    });

    it('should correlate responses by id', async () => {
      // Start two concurrent requests
      const promise1 = client.refresh(false);
      const promise2 = client.refresh(true);

      // Return responses out of order
      setTimeout(() => {
        messageHandler?.({
          id: '2',
          type: 'refresh',
          success: true,
          data: { changes: { length: 20 }, serverCount: 200 },
        });
      }, 5);

      setTimeout(() => {
        messageHandler?.({
          id: '1',
          type: 'refresh',
          success: true,
          data: { changes: { length: 10 }, serverCount: 100 },
        });
      }, 10);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Each promise should receive its correct response
      expect(result1.changes).toBe(10);
      expect(result1.serverCount).toBe(100);
      expect(result2.changes).toBe(20);
      expect(result2.serverCount).toBe(200);
    });
  });

  describe('enrich', () => {
    beforeEach(() => {
      client.startWorker();
    });

    it('should send enrich command and return counts', async () => {
      const enrichPromise = client.enrich();

      setTimeout(() => {
        messageHandler?.({
          id: '1',
          type: 'enrich',
          success: true,
          data: {
            enriched: 15,
            failed: 3,
          },
        });
      }, 10);

      const result = await enrichPromise;

      expect(result.enriched).toBe(15);
      expect(result.failed).toBe(3);
    });
  });

  describe('fullRefresh', () => {
    beforeEach(() => {
      client.startWorker();
    });

    it('should send full_refresh command', async () => {
      const refreshPromise = client.fullRefresh();

      setTimeout(() => {
        messageHandler?.({
          id: '1',
          type: 'full_refresh',
          success: true,
          data: {
            serverCount: 150,
          },
        });
      }, 10);

      const result = await refreshPromise;

      expect(result.serverCount).toBe(150);
      expect(mockWorkerProcess.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'full_refresh' })
      );
    });
  });

  describe('getCatalog', () => {
    it('should return full catalog result', () => {
      const result = client.getCatalog();
      expect(result).toHaveProperty('servers');
      expect(result).toHaveProperty('providerStatus');
      expect(result).toHaveProperty('fetchedAt');
      expect(result).toHaveProperty('isStale');
    });
  });

  describe('isCacheStale', () => {
    it('should check cache staleness', () => {
      const result = client.isCacheStale();
      expect(typeof result).toBe('boolean');
    });
  });
});
