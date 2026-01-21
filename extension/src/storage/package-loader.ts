/**
 * MCP Server Package Loader
 * 
 * Handles loading MCP servers from various package formats:
 * 1. Single-file distributable JSON (.json, .mcp.json) - manifest with embedded base64 code
 * 2. Zip package (.zip, .mcp.zip) - contains manifest.json + server files
 * 3. URL manifest - manifest.json with scriptUrl/wasmUrl pointing to hosted files
 * 
 * All formats are normalized to McpServerManifest with embedded code (scriptBase64/wasmBase64).
 */

import type { McpServerManifest } from '../wasm/types';

export type PackageFormat = 'distributable' | 'zip' | 'manifest-url';

export type LoadResult = {
  success: true;
  manifest: McpServerManifest;
  format: PackageFormat;
  sourceUrl?: string;
} | {
  success: false;
  error: string;
};

/**
 * Detect package format from URL or content type.
 */
export function detectFormat(url: string, contentType?: string): PackageFormat {
  const lowerUrl = url.toLowerCase();
  
  // Check by extension first
  if (lowerUrl.endsWith('.zip') || lowerUrl.endsWith('.mcp.zip')) {
    return 'zip';
  }
  
  // Check content type
  if (contentType) {
    if (contentType.includes('application/zip') || contentType.includes('application/x-zip')) {
      return 'zip';
    }
  }
  
  // Default to distributable JSON (which can also be a manifest-url)
  return 'distributable';
}

/**
 * Load an MCP server package from a URL.
 * Automatically detects format and normalizes to McpServerManifest.
 */
export async function loadFromUrl(url: string): Promise<LoadResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${response.status} ${response.statusText}` };
    }
    
    const contentType = response.headers.get('content-type') || '';
    const format = detectFormat(url, contentType);
    
    if (format === 'zip') {
      return loadZipPackage(await response.arrayBuffer(), url);
    } else {
      return loadJsonPackage(await response.text(), url);
    }
  } catch (err) {
    return { success: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Load from a File object (for drag-drop or file input).
 */
export async function loadFromFile(file: File): Promise<LoadResult> {
  try {
    const format = detectFormat(file.name, file.type);
    
    if (format === 'zip') {
      return loadZipPackage(await file.arrayBuffer(), file.name);
    } else {
      return loadJsonPackage(await file.text(), file.name);
    }
  } catch (err) {
    return { success: false, error: `File read error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Load a JSON package (distributable or manifest-url).
 */
async function loadJsonPackage(jsonText: string, sourceUrl: string): Promise<LoadResult> {
  let manifest: McpServerManifest;
  
  try {
    manifest = JSON.parse(jsonText);
  } catch (err) {
    return { success: false, error: 'Invalid JSON' };
  }
  
  // Validate required fields
  if (!manifest.id || !manifest.name) {
    return { success: false, error: 'Missing required fields: id and name' };
  }
  
  // Check if it's already a distributable (has embedded code)
  if (manifest.scriptBase64 || manifest.wasmBase64 || manifest.moduleBytesBase64) {
    return { 
      success: true, 
      manifest, 
      format: 'distributable',
      sourceUrl 
    };
  }
  
  // It's a manifest-url - need to fetch the code
  const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
  
  if (manifest.runtime === 'js' && manifest.scriptUrl) {
    const scriptFullUrl = resolveUrl(manifest.scriptUrl, baseUrl);
    const scriptResult = await fetchCode(scriptFullUrl);
    
    if (!scriptResult.success) {
      return { success: false, error: `Failed to load script: ${scriptResult.error}` };
    }
    
    // Embed the code as base64
    manifest = {
      ...manifest,
      scriptBase64: btoa(unescape(encodeURIComponent(scriptResult.code))),
      scriptUrl: undefined, // Remove URL since code is now embedded
    };
    
    return { success: true, manifest, format: 'manifest-url', sourceUrl };
  }
  
  if (manifest.runtime === 'wasm' && (manifest.moduleUrl || manifest.wasmUrl)) {
    const wasmUrl = manifest.moduleUrl || manifest.wasmUrl;
    const wasmFullUrl = resolveUrl(wasmUrl!, baseUrl);
    const wasmResult = await fetchBinary(wasmFullUrl);
    
    if (!wasmResult.success) {
      return { success: false, error: `Failed to load WASM: ${wasmResult.error}` };
    }
    
    // Embed the WASM as base64
    manifest = {
      ...manifest,
      wasmBase64: arrayBufferToBase64(wasmResult.data),
      moduleUrl: undefined,
      wasmUrl: undefined,
    };
    
    return { success: true, manifest, format: 'manifest-url', sourceUrl };
  }
  
  return { success: false, error: 'No executable code found (missing scriptUrl, scriptBase64, moduleUrl, or wasmBase64)' };
}

/**
 * Load a ZIP package.
 * Expects the zip to contain:
 * - manifest.json (required)
 * - server code file (referenced by scriptUrl or moduleUrl in manifest)
 */
async function loadZipPackage(data: ArrayBuffer, sourceUrl: string): Promise<LoadResult> {
  try {
    // Use JSZip if available, otherwise fall back to manual extraction
    const files = await extractZip(data);
    
    // Find manifest.json
    const manifestEntry = files.find(f => 
      f.name === 'manifest.json' || 
      f.name.endsWith('/manifest.json')
    );
    
    if (!manifestEntry) {
      return { success: false, error: 'No manifest.json found in zip' };
    }
    
    let manifest: McpServerManifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
    } catch {
      return { success: false, error: 'Invalid manifest.json in zip' };
    }
    
    // Validate required fields
    if (!manifest.id || !manifest.name) {
      return { success: false, error: 'Missing required fields: id and name' };
    }
    
    // Find and embed the code
    if (manifest.runtime === 'js' && manifest.scriptUrl) {
      const scriptName = manifest.scriptUrl.replace(/^\.?\//, '');
      const scriptEntry = files.find(f => 
        f.name === scriptName || 
        f.name.endsWith('/' + scriptName) ||
        f.name === 'server.js' ||
        f.name.endsWith('.js')
      );
      
      if (!scriptEntry) {
        return { success: false, error: `Script file not found in zip: ${manifest.scriptUrl}` };
      }
      
      const scriptText = new TextDecoder().decode(scriptEntry.data);
      manifest = {
        ...manifest,
        scriptBase64: btoa(unescape(encodeURIComponent(scriptText))),
        scriptUrl: undefined,
      };
    } else if (manifest.runtime === 'wasm' && (manifest.moduleUrl || manifest.wasmUrl || manifest.entrypoint)) {
      const wasmName = (manifest.moduleUrl || manifest.wasmUrl || manifest.entrypoint || '').replace(/^\.?\//, '');
      const wasmEntry = files.find(f => 
        f.name === wasmName || 
        f.name.endsWith('/' + wasmName) ||
        f.name.endsWith('.wasm')
      );
      
      if (!wasmEntry) {
        return { success: false, error: `WASM file not found in zip: ${wasmName}` };
      }
      
      manifest = {
        ...manifest,
        wasmBase64: arrayBufferToBase64(wasmEntry.data),
        moduleUrl: undefined,
        wasmUrl: undefined,
      };
    } else if (!manifest.scriptBase64 && !manifest.wasmBase64 && !manifest.moduleBytesBase64) {
      return { success: false, error: 'No executable code found in manifest or zip' };
    }
    
    return { success: true, manifest, format: 'zip', sourceUrl };
  } catch (err) {
    return { success: false, error: `Zip extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Extract files from a ZIP archive.
 * Uses a simple ZIP parser - no external dependencies.
 */
async function extractZip(data: ArrayBuffer): Promise<Array<{ name: string; data: Uint8Array }>> {
  const view = new DataView(data);
  const files: Array<{ name: string; data: Uint8Array }> = [];
  
  let offset = 0;
  const bytes = new Uint8Array(data);
  
  while (offset < data.byteLength - 4) {
    // Check for local file header signature (0x04034b50)
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) {
      // Not a local file header - might be central directory, stop here
      break;
    }
    
    // Read local file header
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);
    
    const fileNameStart = offset + 30;
    const fileName = new TextDecoder().decode(bytes.slice(fileNameStart, fileNameStart + fileNameLength));
    
    const dataStart = fileNameStart + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const compressedData = bytes.slice(dataStart, dataEnd);
    
    // Skip directories
    if (!fileName.endsWith('/')) {
      let fileData: Uint8Array;
      
      if (compressionMethod === 0) {
        // Stored (no compression)
        fileData = compressedData;
      } else if (compressionMethod === 8) {
        // Deflate compression - use DecompressionStream if available
        try {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(compressedData);
          writer.close();
          
          const reader = ds.readable.getReader();
          const chunks: Uint8Array[] = [];
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          
          // Concatenate chunks
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          fileData = new Uint8Array(totalLength);
          let pos = 0;
          for (const chunk of chunks) {
            fileData.set(chunk, pos);
            pos += chunk.length;
          }
        } catch (err) {
          console.warn(`Failed to decompress ${fileName}:`, err);
          // Try treating as uncompressed
          fileData = compressedData;
        }
      } else {
        console.warn(`Unknown compression method ${compressionMethod} for ${fileName}`);
        fileData = compressedData;
      }
      
      files.push({ name: fileName, data: fileData });
    }
    
    offset = dataEnd;
  }
  
  return files;
}

/**
 * Resolve a relative URL against a base URL.
 */
function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('chrome-extension://')) {
    return url;
  }
  
  // Handle relative paths
  if (url.startsWith('./')) {
    url = url.slice(2);
  }
  
  return baseUrl + url;
}

/**
 * Fetch code (text) from a URL.
 */
async function fetchCode(url: string): Promise<{ success: true; code: string } | { success: false; error: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `${response.status} ${response.statusText}` };
    }
    return { success: true, code: await response.text() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch binary data from a URL.
 */
async function fetchBinary(url: string): Promise<{ success: true; data: ArrayBuffer } | { success: false; error: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `${response.status} ${response.statusText}` };
    }
    return { success: true, data: await response.arrayBuffer() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convert ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
