#!/usr/bin/env node
/**
 * Acme Shop MCP Server - HTTP/SSE Transport
 * 
 * This wraps the MCP server to be accessible over HTTP using Server-Sent Events.
 * Websites can declare this server via <link rel="mcp-server"> and the browser
 * will automatically connect when the user opens the chatbot.
 * 
 * Run with: node http-server.js
 * Then access at: http://localhost:3001/mcp
 */

import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = 3001;

// Product catalog
const PRODUCTS = {
  'wireless-headphones': {
    id: 'wireless-headphones',
    name: 'Wireless Headphones Pro',
    price: 149.99,
    description: 'Premium wireless headphones with active noise cancellation, 30-hour battery life, and crystal-clear audio.',
    category: 'audio',
    rating: 5,
    reviews: 128,
    inStock: true
  },
  'smart-watch': {
    id: 'smart-watch',
    name: 'Smart Watch Series X',
    price: 299.99,
    description: 'Advanced smartwatch with health monitoring, GPS, and 5-day battery life. Water resistant to 50m.',
    category: 'wearables',
    rating: 4,
    reviews: 89,
    inStock: true
  },
  'laptop-stand': {
    id: 'laptop-stand',
    name: 'Ergonomic Laptop Stand',
    price: 59.99,
    description: 'Adjustable aluminum laptop stand for better posture. Compatible with laptops up to 17 inches.',
    category: 'accessories',
    rating: 5,
    reviews: 256,
    inStock: true
  },
  'mechanical-keyboard': {
    id: 'mechanical-keyboard',
    name: 'Mechanical Keyboard RGB',
    price: 129.99,
    description: 'Tactile mechanical keyboard with customizable RGB lighting and programmable keys.',
    category: 'accessories',
    rating: 4,
    reviews: 64,
    inStock: false
  },
  'webcam-hd': {
    id: 'webcam-hd',
    name: 'HD Webcam 4K',
    price: 89.99,
    description: '4K webcam with auto-focus, noise-canceling microphone, and low-light correction.',
    category: 'accessories',
    rating: 5,
    reviews: 192,
    inStock: true
  },
  'usb-hub': {
    id: 'usb-hub',
    name: 'USB-C Hub 7-in-1',
    price: 49.99,
    description: 'Compact USB-C hub with HDMI, USB-A, SD card reader, and power delivery support.',
    category: 'accessories',
    rating: 4,
    reviews: 156,
    inStock: true
  }
};

// Per-session carts (keyed by session ID)
const carts = new Map();

function getCart(sessionId) {
  if (!carts.has(sessionId)) {
    carts.set(sessionId, []);
  }
  return carts.get(sessionId);
}

// Create MCP server instance
function createMcpServer(sessionId) {
  const server = new Server(
    { name: 'acme-shop', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_products',
        description: 'Search the Acme Shop product catalog by keyword.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_product_details',
        description: 'Get detailed information about a specific product.',
        inputSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string', description: 'Product ID' }
          },
          required: ['productId']
        }
      },
      {
        name: 'add_to_cart',
        description: 'Add a product to the shopping cart.',
        inputSchema: {
          type: 'object',
          properties: {
            productId: { type: 'string', description: 'Product ID' },
            quantity: { type: 'number', description: 'Quantity (default: 1)' }
          },
          required: ['productId']
        }
      },
      {
        name: 'get_cart',
        description: 'View the current shopping cart.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cart = getCart(sessionId);

    switch (name) {
      case 'search_products': {
        const query = (args.query || '').toLowerCase();
        const results = Object.values(PRODUCTS).filter(p =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.category.toLowerCase().includes(query)
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              count: results.length,
              products: results.map(p => ({
                id: p.id,
                name: p.name,
                price: `$${p.price}`,
                inStock: p.inStock ? 'In Stock' : 'Out of Stock'
              }))
            }, null, 2)
          }]
        };
      }

      case 'get_product_details': {
        const product = PRODUCTS[args.productId];
        if (!product) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Product not found' }) }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...product,
              price: `$${product.price}`
            }, null, 2)
          }]
        };
      }

      case 'add_to_cart': {
        const product = PRODUCTS[args.productId];
        if (!product) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Product not found' }) }], isError: true };
        }
        if (!product.inStock) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Out of stock' }) }], isError: true };
        }
        const qty = args.quantity || 1;
        for (let i = 0; i < qty; i++) cart.push(product);
        const total = cart.reduce((s, p) => s + p.price, 0);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              added: { name: product.name, quantity: qty },
              cartTotal: `$${total.toFixed(2)}`,
              itemCount: cart.length
            }, null, 2)
          }]
        };
      }

      case 'get_cart': {
        if (cart.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ empty: true, message: 'Cart is empty' }) }] };
        }
        const total = cart.reduce((s, p) => s + p.price, 0);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              items: cart.map(p => ({ name: p.name, price: `$${p.price}` })),
              total: `$${total.toFixed(2)}`
            }, null, 2)
          }]
        };
      }

      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  });

  return server;
}

// HTTP server with SSE transport
const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'acme-shop-mcp' }));
    return;
  }

  // MCP SSE endpoint
  if (url.pathname === '/mcp' || url.pathname === '/sse') {
    console.log(`[MCP] New SSE connection from ${req.socket.remoteAddress}`);
    
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const transport = new SSEServerTransport('/mcp', res);
    const server = createMcpServer(sessionId);

    res.on('close', () => {
      console.log(`[MCP] Connection closed: ${sessionId}`);
      carts.delete(sessionId);
    });

    await server.connect(transport);
    return;
  }

  // Info page
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Acme Shop MCP Server</title></head>
      <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>🛒 Acme Shop MCP Server</h1>
        <p>This MCP server provides shopping tools for the BYOC demo.</p>
        <h2>Endpoints</h2>
        <ul>
          <li><code>/mcp</code> - SSE endpoint for MCP connections</li>
          <li><code>/health</code> - Health check</li>
        </ul>
        <h2>Tools</h2>
        <ul>
          <li><strong>search_products</strong> - Search the catalog</li>
          <li><strong>get_product_details</strong> - Get product info</li>
          <li><strong>add_to_cart</strong> - Add to cart</li>
          <li><strong>get_cart</strong> - View cart</li>
        </ul>
        <p><a href="http://localhost:8000/bring-your-chatbot/">← Back to Demo</a></p>
      </body>
      </html>
    `);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(PORT, () => {
  console.log(`🛒 Acme Shop MCP Server running at http://localhost:${PORT}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/mcp`);
  console.log('');
  console.log('This server will be automatically connected when you use the BYOC demo.');
});
