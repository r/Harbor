#!/usr/bin/env node
/**
 * Acme Shop MCP Server
 * 
 * A real MCP server that exposes shopping tools for the BYOC demo.
 * This demonstrates a website providing its own MCP server that the
 * user's browser chatbot can connect to.
 * 
 * Tools:
 * - search_products: Search the product catalog
 * - get_product_details: Get details about a specific product
 * - add_to_cart: Add a product to the shopping cart
 * - get_cart: View the current cart contents
 * 
 * Run with: node server.js
 * Or via Harbor: Install from the demo page
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Product catalog
const PRODUCTS = {
  'wireless-headphones': {
    id: 'wireless-headphones',
    name: 'Wireless Headphones Pro',
    price: 149.99,
    description: 'Premium wireless headphones with active noise cancellation, 30-hour battery life, and crystal-clear audio. Features Bluetooth 5.2, comfortable over-ear design, and foldable build for easy travel.',
    category: 'audio',
    rating: 5,
    reviews: 128,
    inStock: true
  },
  'smart-watch': {
    id: 'smart-watch',
    name: 'Smart Watch Series X',
    price: 299.99,
    description: 'Advanced smartwatch with health monitoring, GPS, and 5-day battery life. Water resistant to 50m. Includes heart rate monitor, sleep tracking, and 100+ workout modes.',
    category: 'wearables',
    rating: 4,
    reviews: 89,
    inStock: true
  },
  'laptop-stand': {
    id: 'laptop-stand',
    name: 'Ergonomic Laptop Stand',
    price: 59.99,
    description: 'Adjustable aluminum laptop stand for better posture. Compatible with laptops up to 17 inches. Features 6 height levels and cable management.',
    category: 'accessories',
    rating: 5,
    reviews: 256,
    inStock: true
  },
  'mechanical-keyboard': {
    id: 'mechanical-keyboard',
    name: 'Mechanical Keyboard RGB',
    price: 129.99,
    description: 'Tactile mechanical keyboard with customizable RGB lighting and programmable keys. Cherry MX Brown switches, full N-key rollover, and detachable USB-C cable.',
    category: 'accessories',
    rating: 4,
    reviews: 64,
    inStock: false
  },
  'webcam-hd': {
    id: 'webcam-hd',
    name: 'HD Webcam 4K',
    price: 89.99,
    description: '4K webcam with auto-focus, noise-canceling microphone, and low-light correction. Perfect for video calls and streaming. Includes privacy cover.',
    category: 'accessories',
    rating: 5,
    reviews: 192,
    inStock: true
  },
  'usb-hub': {
    id: 'usb-hub',
    name: 'USB-C Hub 7-in-1',
    price: 49.99,
    description: 'Compact USB-C hub with HDMI 4K@60Hz, 2x USB-A 3.0, SD card reader, microSD reader, and 100W power delivery passthrough.',
    category: 'accessories',
    rating: 4,
    reviews: 156,
    inStock: true
  }
};

// Shopping cart (in-memory for demo)
let cart = [];

// Create MCP server
const server = new Server(
  {
    name: 'acme-shop',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_products',
        description: 'Search the Acme Shop product catalog by keyword. Returns matching products with name, price, and availability.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (e.g., "headphones", "laptop", "accessories")'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'get_product_details',
        description: 'Get detailed information about a specific product including full description, specs, and reviews.',
        inputSchema: {
          type: 'object',
          properties: {
            productId: {
              type: 'string',
              description: 'Product ID (e.g., "wireless-headphones", "smart-watch")'
            }
          },
          required: ['productId']
        }
      },
      {
        name: 'add_to_cart',
        description: 'Add a product to the shopping cart. Returns the updated cart total.',
        inputSchema: {
          type: 'object',
          properties: {
            productId: {
              type: 'string',
              description: 'Product ID to add to cart'
            },
            quantity: {
              type: 'number',
              description: 'Quantity to add (default: 1)'
            }
          },
          required: ['productId']
        }
      },
      {
        name: 'get_cart',
        description: 'View the current shopping cart contents and total.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'search_products': {
      const query = (args.query || '').toLowerCase();
      const results = Object.values(PRODUCTS).filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.category.toLowerCase().includes(query)
      );

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              message: `No products found matching "${args.query}"`,
              suggestions: ['Try searching for: headphones, watch, keyboard, webcam, laptop, or usb']
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            count: results.length,
            products: results.map(p => ({
              id: p.id,
              name: p.name,
              price: `$${p.price.toFixed(2)}`,
              rating: `${'⭐'.repeat(p.rating)} (${p.reviews} reviews)`,
              availability: p.inStock ? '✓ In Stock' : '✗ Out of Stock'
            }))
          }, null, 2)
        }]
      };
    }

    case 'get_product_details': {
      const product = PRODUCTS[args.productId];
      if (!product) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Product not found',
              message: `No product with ID "${args.productId}"`,
              availableIds: Object.keys(PRODUCTS)
            }, null, 2)
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: product.id,
            name: product.name,
            price: `$${product.price.toFixed(2)}`,
            description: product.description,
            category: product.category,
            rating: `${product.rating}/5 stars (${product.reviews} reviews)`,
            availability: product.inStock ? 'In Stock - Ready to ship!' : 'Out of Stock - Check back soon',
            canAddToCart: product.inStock
          }, null, 2)
        }]
      };
    }

    case 'add_to_cart': {
      const product = PRODUCTS[args.productId];
      if (!product) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Product not found',
              message: `No product with ID "${args.productId}"`
            }, null, 2)
          }],
          isError: true
        };
      }

      if (!product.inStock) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Out of stock',
              message: `Sorry, "${product.name}" is currently out of stock.`
            }, null, 2)
          }],
          isError: true
        };
      }

      const quantity = args.quantity || 1;
      for (let i = 0; i < quantity; i++) {
        cart.push(product);
      }

      const total = cart.reduce((sum, p) => sum + p.price, 0);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Added ${quantity}x "${product.name}" to cart`,
            itemAdded: {
              name: product.name,
              price: `$${product.price.toFixed(2)}`,
              quantity: quantity
            },
            cart: {
              itemCount: cart.length,
              total: `$${total.toFixed(2)}`
            }
          }, null, 2)
        }]
      };
    }

    case 'get_cart': {
      if (cart.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              empty: true,
              message: 'Your cart is empty. Start shopping!',
              suggestions: ['Search for products or ask for recommendations']
            }, null, 2)
          }]
        };
      }

      // Group items by product
      const grouped = {};
      cart.forEach(p => {
        if (!grouped[p.id]) {
          grouped[p.id] = { ...p, quantity: 0 };
        }
        grouped[p.id].quantity++;
      });

      const total = cart.reduce((sum, p) => sum + p.price, 0);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            items: Object.values(grouped).map(p => ({
              name: p.name,
              price: `$${p.price.toFixed(2)}`,
              quantity: p.quantity,
              subtotal: `$${(p.price * p.quantity).toFixed(2)}`
            })),
            summary: {
              itemCount: cart.length,
              total: `$${total.toFixed(2)}`
            }
          }, null, 2)
        }]
      };
    }

    default:
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2)
        }],
        isError: true
      };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Acme Shop MCP Server running on stdio');
}

main().catch(console.error);
