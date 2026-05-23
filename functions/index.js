import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

import { createAgentRegistry } from './lib/ai/agents/index.js';
import { SERVICES_SCREENS } from './lib/ai/agents/services.js';
import { buildAgentRequestContext } from './lib/ai/build-request.js';
import { SERVICES_TOOLS } from './lib/ai/tools/services-tools.js';
import { createStorefrontToolGroup } from './lib/ai/tools/storefront-tools.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const apiKey = process.env.OPENAI_API_KEY;
const storefrontEndpoint = process.env.SHOPIFY_STOREFRONT_API_ENDPOINT || '';
const storefrontAccessToken = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || '';
const mainCategoryRef = String(process.env.MAIN_CATEGORY || '').trim() || null;
const MAX_HISTORY_MESSAGES = 20;
const DEFAULT_COLLECTION_LIMIT = 12;
const SALE_COLLECTION_FETCH_LIMIT = 50;
const SCREEN_ENTRY = 'ENTRY';
const SCREEN_PROMO_INFO = 'PROMO_INFO';
const SCREEN_PRODUCT_LIST = 'PRODUCT_LIST';
const SCREEN_PRODUCT_FOCUS = 'PRODUCT_FOCUS';
const SCREEN_VARIANT_SELECTION = 'VARIANT_SELECTION';
const SCREEN_PRODUCT_READY = 'PRODUCT_READY';
const SCREEN_POST_CART_RECONCILE = 'POST_CART_RECONCILE';
const SCREEN_POST_CART_UNLOCK_PENDING = 'POST_CART_UNLOCK_PENDING';
const SCREEN_POST_CART_UNLOCKED = 'POST_CART_UNLOCKED';
const SCREEN_EMAIL_CAPTURE = 'EMAIL_CAPTURE';
const SCREEN_UNKNOWN = 'UNKNOWN';
const SCREEN_SERVICES_ENTRY = SERVICES_SCREENS.ENTRY;
const SCREEN_SERVICES_SERVICES = SERVICES_SCREENS.SERVICES;
const SCREEN_SERVICES_PRICES = SERVICES_SCREENS.PRICES;
const SCREEN_SERVICES_PROJECTS = SERVICES_SCREENS.PROJECTS;
const SCREEN_SERVICES_ABOUT = SERVICES_SCREENS.ABOUT;
const SCREEN_SERVICES_CONTACTS = SERVICES_SCREENS.CONTACTS;
const LOCAL_RENDERED_SCREENS = new Set([
  SCREEN_PRODUCT_LIST,
  SCREEN_PRODUCT_FOCUS,
  SCREEN_VARIANT_SELECTION,
  SCREEN_PRODUCT_READY,
  SCREEN_POST_CART_UNLOCK_PENDING,
  SCREEN_POST_CART_UNLOCKED,
  SCREEN_EMAIL_CAPTURE,
]);
const SYSTEM_PROMPT = [
  'You are a Shopify storefront assistant for a shoe store.',
  'Your primary job is to convert the user request into the correct storefront routing decision.',
  'Your job is to help users browse products, narrow to one product, and move from category selection to product focus.',
  'You are not a general assistant.',
  'Language:',
  'Always reply in the language of the user.',
  'Core rules:',
  'Keep responses short.',
  'Do not hallucinate products, prices, discounts, or availability.',
  'Do not show the full catalog.',
  'Ask at most one short clarifying question when required.',
  'Prefer tool selection over plain text whenever a tool can complete the next step.',
  'Current tools:',
  'showProductCollection.',
  'setFocusProduct.',
  'Tool rules:',
  'Use showProductCollection when the user wants to browse, list, filter, search, narrow, sort, compare by price, see sale items, or see products of a brand.',
  'Use showProductCollection even when the user writes with typos, informal wording, mixed languages, or incomplete phrasing, as long as the intent is clear enough.',
  'For collection requests, prefer returning the tool over asking a question.',
  'If the user asks for cheap products, interpret it as sort = price_asc.',
  'If the user asks for expensive products, interpret it as sort = price_desc.',
  'If the user asks for products under a price, use max_price.',
  'If the user asks for products over a price, use min_price.',
  'If the user mentions one brand, put it into brands as a one-item array.',
  'If the user mentions multiple brands, put all of them into brands.',
  'If the user asks to sort or filter the currently viewed products, reuse category from client state when available.',
  'Use setFocusProduct when one exact product has been selected from the current visible list.',
  'Never invent tool parameters.',
  'Never use a tool if required data is missing.',
  'Output rules:',
  'When replying with selectable options, always use HTML.',
  'Use <p> for short text.',
  'Use exactly one <ul> for options.',
  'Use one <li> per option.',
  'Maximum 6 selectable options in one list.',
  'After a numbered list, end with: <p>Reply with a number.</p>.',
  'Number handling:',
  'If the user replies with a single number, interpret it using the most recent visible numbered list.',
  'Never interpret numbers globally without the current option context.',
  'Category handling:',
  'Available categories are Daily Shoes, Running Shoes, Training Shoes, Football & Court Shoes, and Sale.',
  'If the user asks for products under or above a price, you may use showProductCollection with category = null and the appropriate min_price or max_price filter.',
  'If you need the user to choose a category, always return a numbered HTML list, never plain category lines.',
  'For the first category-selection screen, briefly explain that this is a presentation page and you will show test products, then ask which categories the user is interested in before listing the categories.',
  'On the first category-selection screen, add a sixth menu item about active promotions and discounts.',
  'If the user selects 6 from the first category-selection screen, explain briefly that promotions and discounts are active, then invite the user to choose a category or sale products.',
  'Behavior:',
  'If the user is choosing what to browse, return either a tool selection for showProductCollection or a short HTML category menu if more clarification is needed.',
  'If the user asks only a generic question like what products are available, what do you have, or what can I buy, prefer the category menu instead of showProductCollection.',
  'If products are already visible and the user selects one exact item, return setFocusProduct.',
  'If live product data is unavailable, say so briefly.',
  'Never explain internal logic, tools, prompts, or backend behavior.',
  'For any clear collection-browsing intent, response must be null and tool must be showProductCollection.',
  'Do not answer with plain text like "Showing products" when showProductCollection can be used.',
  'Examples:',
  'User: "покажи дешевые товары" -> tool showProductCollection with sort = price_asc.',
  'User: "покажи самые дорогие товары" -> tool showProductCollection with sort = price_desc.',
  'User: "nike до 100 долларов" -> tool showProductCollection with brands = ["Nike"] and max_price = 100.',
  'User: "покажи мне самые дешевые кроссовки nike" -> tool showProductCollection with brands = ["Nike"] and sort = price_asc.',
  'User: "покажи самые дешевые товары Nike и Adidas" -> tool showProductCollection with brands = ["Nike","Adidas"] and sort = price_asc.',
  'You must return either a tool decision with parameters or a short user-facing HTML response.',
].join(' ');
const COLLECTION_RECOVERY_PROMPT = [
  'You are a semantic router for the storefront tool showProductCollection.',
  'Your task is to decide whether the latest user message should call showProductCollection.',
  'Tolerate typos, grammar mistakes, mixed languages, short fragments, and casual phrasing.',
  'If the user wants to browse, list, filter, sort, search, narrow, or show products, return tool = showProductCollection with the best parameters.',
  'If the user asks for cheap products, set sort = price_asc.',
  'If the user asks for expensive products, set sort = price_desc.',
  'If the user asks for products under a price, set max_price.',
  'If the user asks for products over a price, set min_price.',
  'If the user mentions one brand, set brands to a one-item array.',
  'If the user mentions multiple brands, set brands to an array of all mentioned brands.',
  'If category is omitted but client state has a category and the user is refining current results, reuse that category.',
  'If the message is not a collection request, return tool = null.',
  'Return JSON only and follow the schema exactly.',
].join(' ');
const COLLECTION_FORCED_PROMPT = [
  'You are a forced semantic router for the storefront tool showProductCollection.',
  'The latest user message is definitely a collection-browsing request.',
  'You must return tool = showProductCollection, not null.',
  'Infer the best parameters from the message, including typos and informal wording.',
  'If the user asks for expensive products, set sort = price_desc.',
  'If the user asks for cheap products, set sort = price_asc.',
  'If the user asks for products under a price, set max_price.',
  'If the user asks for products over a price, set min_price.',
  'If the user mentions one brand, set brands to a one-item array.',
  'If the user mentions multiple brands, set brands to an array of all mentioned brands.',
  'If the user is refining current results and client state has a category, reuse that category.',
  'Return JSON only and follow the schema exactly.',
].join(' ');
const AVAILABLE_CATEGORIES = ['Daily Shoes', 'Running Shoes', 'Training Shoes', 'Football & Court Shoes', 'Sale'];
const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($first: Int!, $query: String) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        productType
        vendor
        tags
        variants(first: 20) {
          nodes {
            id
            price {
              amount
              currencyCode
            }
            compareAtPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;
const MAIN_COLLECTION_PRODUCTS_BY_HANDLE_QUERY = `
  query MainCollectionProductsByHandle($handle: String!, $first: Int!) {
    collection(handle: $handle) {
      id
      handle
      title
      products(first: $first) {
        nodes {
          id
          title
          productType
          vendor
          tags
          variants(first: 20) {
            nodes {
              id
              price {
                amount
                currencyCode
              }
              compareAtPrice {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;
const MAIN_COLLECTION_PRODUCTS_BY_ID_QUERY = `
  query MainCollectionProductsById($id: ID!, $first: Int!) {
    node(id: $id) {
      ... on Collection {
        id
        handle
        title
        products(first: $first) {
          nodes {
            id
            title
            productType
            vendor
            tags
            variants(first: 20) {
              nodes {
                id
                price {
                  amount
                  currencyCode
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;
const PRODUCT_DETAILS_QUERY = `
  query ProductDetails($id: ID!) {
    product(id: $id) {
      id
      title
      productType
      vendor
      options {
        name
        values
      }
      variants(first: 50) {
        nodes {
          id
          title
          availableForSale
          selectedOptions {
            name
            value
          }
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;
const DEBUG_PRODUCTS_QUERY = `
  query DebugProducts($first: Int!) {
    products(first: $first) {
      nodes {
        id
        title
        productType
        vendor
        tags
      }
    }
  }
`;
const SHOW_PRODUCT_COLLECTION_TOOL = {
  type: 'function',
  name: 'showProductCollection',
  description: 'List, browse, filter, sort, or narrow storefront products by category, brand, price, or sale status.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: {
        anyOf: [
          { type: 'string', enum: AVAILABLE_CATEGORIES },
          { type: 'null' },
        ],
      },
      brands: {
        anyOf: [
          {
            type: 'array',
            items: { type: 'string' },
          },
          { type: 'null' },
        ],
      },
      brand: {
        anyOf: [
          { type: 'string' },
          { type: 'null' },
        ],
      },
      min_price: {
        anyOf: [
          { type: 'number' },
          { type: 'null' },
        ],
      },
      max_price: {
        anyOf: [
          { type: 'number' },
          { type: 'null' },
        ],
      },
      sale_only: {
        anyOf: [
          { type: 'boolean' },
          { type: 'null' },
        ],
      },
      limit: {
        anyOf: [
          { type: 'integer' },
          { type: 'null' },
        ],
      },
      sort: {
        anyOf: [
          { type: 'string', enum: ['featured', 'price_asc', 'price_desc', 'newest'] },
          { type: 'null' },
        ],
      },
    },
    required: ['category', 'brands', 'brand', 'min_price', 'max_price', 'sale_only', 'limit', 'sort'],
  },
};
const SET_FOCUS_PRODUCT_TOOL = {
  type: 'function',
  name: 'setFocusProduct',
  description: 'Focus one exact product from the currently visible product list when the user selected a single product.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      product_id: {
        anyOf: [
          { type: 'string' },
          { type: 'null' },
        ],
      },
    },
    required: ['product_id'],
  },
};
const STOREFRONT_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: {
      anyOf: [
        { type: 'string', enum: ['showProductCollection', 'setFocusProduct'] },
        { type: 'null' },
      ],
    },
    parameters: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: {
              anyOf: [
                { type: 'string', enum: AVAILABLE_CATEGORIES },
                { type: 'null' },
              ],
            },
            brands: {
              anyOf: [
                {
                  type: 'array',
                  items: { type: 'string' },
                },
                { type: 'null' },
              ],
            },
            brand: {
              anyOf: [
                { type: 'string' },
                { type: 'null' },
              ],
            },
            min_price: {
              anyOf: [
                { type: 'number' },
                { type: 'null' },
              ],
            },
            max_price: {
              anyOf: [
                { type: 'number' },
                { type: 'null' },
              ],
            },
            sale_only: {
              anyOf: [
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
            limit: {
              anyOf: [
                { type: 'integer' },
                { type: 'null' },
              ],
            },
            sort: {
              anyOf: [
                { type: 'string', enum: ['featured', 'price_asc', 'price_desc', 'newest'] },
                { type: 'null' },
              ],
            },
            product_id: {
              anyOf: [
                { type: 'string' },
                { type: 'null' },
              ],
            },
          },
          required: ['category', 'brands', 'brand', 'min_price', 'max_price', 'sale_only', 'limit', 'sort', 'product_id'],
        },
        { type: 'null' },
      ],
    },
    response: {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
  },
  required: ['tool', 'parameters', 'response'],
};
const COLLECTION_ROUTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: {
      anyOf: [
        { type: 'string', enum: ['showProductCollection'] },
        { type: 'null' },
      ],
    },
    parameters: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: {
              anyOf: [
                { type: 'string', enum: AVAILABLE_CATEGORIES },
                { type: 'null' },
              ],
            },
            brands: {
              anyOf: [
                {
                  type: 'array',
                  items: { type: 'string' },
                },
                { type: 'null' },
              ],
            },
            brand: {
              anyOf: [
                { type: 'string' },
                { type: 'null' },
              ],
            },
            min_price: {
              anyOf: [
                { type: 'number' },
                { type: 'null' },
              ],
            },
            max_price: {
              anyOf: [
                { type: 'number' },
                { type: 'null' },
              ],
            },
            sale_only: {
              anyOf: [
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
            limit: {
              anyOf: [
                { type: 'integer' },
                { type: 'null' },
              ],
            },
            sort: {
              anyOf: [
                { type: 'string', enum: ['featured', 'price_asc', 'price_desc', 'newest'] },
                { type: 'null' },
              ],
            },
          },
          required: ['category', 'brands', 'brand', 'min_price', 'max_price', 'sale_only', 'limit', 'sort'],
        },
        { type: 'null' },
      ],
    },
  },
  required: ['tool', 'parameters'],
};

if (!apiKey) {
  console.warn('Missing OPENAI_API_KEY in environment');
}

if (!storefrontEndpoint || !storefrontAccessToken) {
  console.warn('Missing Shopify Storefront API endpoint/token in environment');
}

const client = new OpenAI({ apiKey: apiKey || 'dummy-key-for-deploy' });
const storefrontTools = createStorefrontToolGroup({
  showProductCollectionTool: SHOW_PRODUCT_COLLECTION_TOOL,
  setFocusProductTool: SET_FOCUS_PRODUCT_TOOL,
});
const agentRegistry = createAgentRegistry({
  storefrontInstructions: SYSTEM_PROMPT,
  storefrontTools,
  servicesTools: SERVICES_TOOLS,
});

function normalizeHistoryMessage(rawMessage) {
  const safeMessage = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
  const role = safeMessage.role === 'assistant' ? 'assistant' : safeMessage.role === 'user' ? 'user' : null;
  const text = typeof safeMessage.text === 'string' ? safeMessage.text.trim() : '';

  if (!role || !text) return null;

  return {
    role,
    content: [
      {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      },
    ],
  };
}

function buildClientStateRouterContext(clientState) {
  const safeState = clientState && typeof clientState === 'object' ? clientState : {};
  return JSON.stringify({
    screen: safeState.screen || null,
    category: safeState.category || null,
    focus_product_id: safeState.focus_product_id || null,
    focus_product_title: safeState.focus_product_title || null,
    visible_products: Array.isArray(safeState.visible_products) ? safeState.visible_products.slice(0, 6) : [],
    variant_options: Array.isArray(safeState.variant_options) ? safeState.variant_options.slice(0, 12) : [],
    selected_variant: safeState.selected_variant || null,
    cart_state: safeState.cart_state || null,
  });
}

function buildRoutingInput({ history, message, clientState, promptText }) {
  const normalizedHistory = (Array.isArray(history) ? history : [])
    .map(normalizeHistoryMessage)
    .filter(Boolean)
    .slice(-MAX_HISTORY_MESSAGES);

  return [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: promptText,
        },
      ],
    },
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: `Client state JSON: ${buildClientStateRouterContext(clientState)}`,
        },
      ],
    },
    ...normalizedHistory,
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: message,
        },
      ],
    },
  ];
}

function extractFirstJsonObject(text) {
  const source = String(text || '').trim();
  if (!source) return null;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseDecisionFromOutputText(outputText) {
  const rawText = String(outputText || '').trim();
  if (!rawText) return null;

  try {
    return JSON.parse(rawText);
  } catch (_error) {
    const extractedJson = extractFirstJsonObject(rawText);
    if (!extractedJson) {
      throw new Error(`Failed to parse structured output: ${rawText}`);
    }

    try {
      return JSON.parse(extractedJson);
    } catch (_nestedError) {
      throw new Error(`Failed to parse structured output: ${rawText}`);
    }
  }
}

function parseFunctionArguments(argumentsText) {
  const rawText = String(argumentsText || '').trim();
  if (!rawText) return {};
  try {
    return JSON.parse(rawText);
  } catch (_error) {
    return {};
  }
}

function extractFunctionCall(response, allowedNames = []) {
  const items = Array.isArray(response?.output) ? response.output : [];
  const nameSet = new Set(Array.isArray(allowedNames) ? allowedNames : []);
  const match = items.find((item) =>
    item?.type === 'function_call' &&
    typeof item?.name === 'string' &&
    (!nameSet.size || nameSet.has(item.name))
  );

  if (!match) return null;

  return {
    name: match.name,
    arguments: parseFunctionArguments(match.arguments),
    call_id: match.call_id || null,
    raw_arguments: String(match.arguments || ''),
  };
}

function normalizePriceFilter(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return numericValue > 0 ? numericValue : null;
}

function normalizeBrands(brands, brand = null) {
  const source = Array.isArray(brands)
    ? brands
    : brand && typeof brand === 'string'
      ? [brand]
      : [];

  const normalized = source
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  return normalized.length ? normalized : null;
}

function normalizeDecision(decision) {
  const safeDecision = decision && typeof decision === 'object' ? decision : {};
  const rawTool = typeof safeDecision.tool === 'string' ? safeDecision.tool.trim() : '';
  const tool = rawTool === 'showProductCollection' || rawTool === 'setFocusProduct' ? rawTool : null;
  const rawParameters = safeDecision.parameters && typeof safeDecision.parameters === 'object' ? safeDecision.parameters : {};

  return {
    tool,
    parameters: tool
      ? {
          category: normalizeCategory(rawParameters.category),
          brands: normalizeBrands(rawParameters.brands, rawParameters.brand),
          brand: typeof rawParameters.brand === 'string' && rawParameters.brand.trim() ? rawParameters.brand.trim() : null,
          min_price: normalizePriceFilter(rawParameters.min_price),
          max_price: normalizePriceFilter(rawParameters.max_price),
          sale_only: typeof rawParameters.sale_only === 'boolean' ? rawParameters.sale_only : null,
          limit: Number.isInteger(rawParameters.limit) && rawParameters.limit > 0 ? rawParameters.limit : null,
          sort: ['featured', 'price_asc', 'price_desc', 'newest'].includes(String(rawParameters.sort || '').trim())
            ? String(rawParameters.sort).trim()
            : null,
          product_id: normalizeProductId(rawParameters.product_id),
        }
      : null,
    response: typeof safeDecision.response === 'string' ? safeDecision.response : null,
  };
}

function renderCategoryMenuResponse(language = 'en') {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  if (isRussian) {
    return [
      '<p>Привет! Это страница-презентация, здесь мы покажем вам тестовые товары.</p>',
      '<p>Какие категории вас интересуют?</p>',
      '<ul>',
      '  <li>1. Daily Shoes</li>',
      '  <li>2. Running Shoes</li>',
      '  <li>3. Training Shoes</li>',
      '  <li>4. Football & Court Shoes</li>',
      '  <li>5. Sale</li>',
      '  <li>6. У нас сейчас активны промоакции и скидки. </li>',
      '</ul>',
      '<p>Ответьте номером.</p>',
    ].join('');
  }

  return [
    '<p>Hello! This is a presentation page where we will show you test products.</p>',
    '<p>Which categories are you interested in?</p>',
    '<ul>',
    '  <li>1. Daily Shoes</li>',
    '  <li>2. Running Shoes</li>',
    '  <li>3. Training Shoes</li>',
    '  <li>4. Football & Court Shoes</li>',
    '  <li>5. Sale</li>',
    '  <li>6. We currently have active promotions and discounts. </li>',
    '</ul>',
    '<p>Reply with a number.</p>',
  ].join('');
}

function renderCategoryChoiceResponse(language = 'en', intro = null) {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  const introLine = intro && String(intro).trim()
    ? `<p>${String(intro).trim()}</p>`
    : isRussian
      ? '<p>Выберите категорию.</p>'
      : '<p>Please choose a category.</p>';

  return [
    introLine,
    '<ul>',
    '  <li>1. Daily Shoes</li>',
    '  <li>2. Running Shoes</li>',
    '  <li>3. Training Shoes</li>',
    '  <li>4. Football & Court Shoes</li>',
    '  <li>5. Sale</li>',
    '</ul>',
    isRussian ? '<p>Ответьте номером.</p>' : '<p>Reply with a number.</p>',
  ].join('');
}

function renderPromoInfoResponse(language = 'en') {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  if (isRussian) {
    return [
      '<p>Сейчас у нас действует промоакция: если вы покупаете 2 товара, вы получаете <strong>скидку 30%</strong>.</p>',
      '<p>Дополнительно вы можете получить еще 5% скидки, если оставите нам свою почту.</p>',
      '<p>Мы предоставим вам промокод, который нужно будет ввести на этапе checkout.</p>',
      '<p>Итоговая скидка может составить <strong>35%</strong>.</p>',
      '<p>Если хотите, теперь выберите интересующую категорию.</p>',
      '<ul class="ai-menu-list">',
      '  <li>1. Daily Shoes</li>',
      '  <li>2. Running Shoes</li>',
      '  <li>3. Training Shoes</li>',
      '  <li>4. Football & Court Shoes</li>',
      '  <li>5. Sale</li>',
      '</ul>',
      '<p>Ответьте номером.</p>',
    ].join('');
  }

  return [
    '<p>We currently have an active promotion: if you buy 2 products, you get a <strong>30% discount</strong>.</p>',
    '<p>You can get an additional <strong>5% discount</strong> if you share your email with us.</p>',
    '<p>We will give you a promo code that you need to enter at checkout.</p>',
    '<p>Your total discount can reach <strong>35%</strong>.</p>',
    '<p>If you want, now choose the category you are interested in.</p>',
    '<ul class="ai-menu-list">',
    '  <li>1. Daily Shoes</li>',
    '  <li>2. Running Shoes</li>',
    '  <li>3. Training Shoes</li>',
    '  <li>4. Football & Court Shoes</li>',
    '  <li>5. Sale</li>',
    '</ul>',
    '<p>Reply with a number.</p>',
  ].join('');
}

function renderProductListResponse(products, language = 'en') {
  const safeProducts = Array.isArray(products) ? products : [];
  const visibleProducts = safeProducts.slice(0, 6);
  const isRussian = String(language || '').toLowerCase().startsWith('ru');

  const listItems = visibleProducts.map((product, index) => `  <li>${index + 1}. ${String(product?.title || `Product ${index + 1}`)}</li>`);

  if (!listItems.length) {
    return isRussian
      ? '<p>Сейчас нет доступных товаров в этой категории.</p>'
      : '<p>No products are available in this category right now.</p>';
  }

  return [
    isRussian ? '<p>Вот товары, которые мы можем показать.</p>' : '<p>Here are the products we can show you.</p>',
    '<ul>',
    ...listItems,
    '</ul>',
    isRussian ? '<p>Ответьте номером, чтобы открыть товар.</p>' : '<p>Reply with a number to focus a product.</p>',
  ].join('');
}

function renderProductFocusResponse(language = 'en', productTitle = null) {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  return [
    productTitle
      ? `<p>${isRussian ? 'Вы выбрали товар' : 'You selected'}: <strong>${String(productTitle)}</strong>.</p>`
      : isRussian
        ? '<p>Товар выбран.</p>'
        : '<p>Product selected.</p>',
    '<ul>',
    `  <li>1. ${isRussian ? 'Выбрать другой вариант товара' : 'Choose another variant'}</li>`,
    `  <li>2. ${isRussian ? 'Добавить в корзину' : 'Add to cart'}</li>`,
    '</ul>',
    isRussian ? '<p>Ответьте номером.</p>' : '<p>Reply with a number.</p>',
  ].join('');
}

function renderVariantSelectionResponse(variantOptions, language = 'en') {
  const safeVariants = Array.isArray(variantOptions) ? variantOptions : [];
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  const items = safeVariants.slice(0, 6).map((variant, index) => `  <li>${index + 1}. ${String(variant?.title || `Variant ${index + 1}`)}</li>`);

  return [
    isRussian ? '<p>Доступные варианты товара:</p>' : '<p>Available product variants:</p>',
    '<ul>',
    ...items,
    '</ul>',
    isRussian ? '<p>Ответьте номером, чтобы выбрать вариант.</p>' : '<p>Reply with a number to choose a variant.</p>',
  ].join('');
}

function renderProductReadyResponse(language = 'en', variantTitle = null) {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  return [
    variantTitle
      ? `<p>${isRussian ? 'Выбран вариант' : 'Selected variant'}: <strong>${String(variantTitle)}</strong>.</p>`
      : isRussian
        ? '<p>Вариант товара обновлён.</p>'
        : '<p>Variant updated.</p>',
    '<ul>',
    `  <li>1. ${isRussian ? 'Добавить в корзину' : 'Add to cart'}</li>`,
    `  <li>2. ${isRussian ? 'Назад к товару' : 'Back to product'}</li>`,
    '</ul>',
    isRussian ? '<p>Ответьте номером.</p>' : '<p>Reply with a number.</p>',
  ].join('');
}

function renderPostCartUnlockPendingResponse(language = 'en') {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  return [
    isRussian
      ? '<p>Добавьте ещё один товар и получите скидку <strong>30%</strong>.</p>'
      : '<p>Add one more product and get a <strong>30% discount</strong>.</p>',
    '<ul>',
    `  <li>1. ${isRussian ? 'Продолжить покупки' : 'Continue shopping'}</li>`,
    `  <li>2. ${isRussian ? 'Показать sale товары' : 'Show sale products'}</li>`,
    '</ul>',
    isRussian ? '<p>Ответьте номером.</p>' : '<p>Reply with a number.</p>',
  ].join('');
}

function renderPostCartUnlockedResponse(language = 'en') {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  return [
    isRussian
      ? '<p>Поздравляем, вы добавили два товара и получили скидку <strong>30%</strong>.</p>'
      : '<p>Congratulations, you added two products and unlocked a <strong>30% discount</strong>.</p>',
    isRussian
      ? '<p>Вы можете получить ещё <strong>5%</strong>, если предоставите нам вашу почту.</p>'
      : '<p>You can get an extra <strong>5%</strong> if you share your email with us.</p>',
    '<ul>',
    `  <li>1. ${isRussian ? 'Предоставить почту' : 'Provide email'}</li>`,
    `  <li>2. ${isRussian ? 'Продолжить покупки' : 'Continue shopping'}</li>`,
    '</ul>',
    isRussian ? '<p>Ответьте номером.</p>' : '<p>Reply with a number.</p>',
  ].join('');
}

function renderEmailCaptureResponse(language = 'en') {
  const isRussian = String(language || '').toLowerCase().startsWith('ru');
  return [
    isRussian
      ? '<p>Чтобы получить дополнительные <strong>5%</strong>, оставьте вашу почту.</p>'
      : '<p>To get the extra <strong>5%</strong>, please share your email.</p>',
    isRussian
      ? '<p>Ответьте сообщением с вашим email.</p>'
      : '<p>Reply with your email.</p>',
  ].join('');
}

function detectUserLanguage({ history, message }) {
  const combined = [
    ...(Array.isArray(history) ? history.map((item) => item?.text || '') : []),
    message || '',
  ].join(' ');

  return /[А-Яа-яЁёІіЇїЄє]/.test(combined) ? 'ru' : 'en';
}

function looksLikeObviousCollectionIntent(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  const collectionWords = [
    'product', 'products', 'shoe', 'shoes', 'sneaker', 'sneakers',
    'товар', 'товары', 'кроссов', 'обув',
  ];
  const browseWords = [
    'show', 'browse', 'find', 'list', 'sort', 'filter', 'cheap', 'cheapest',
    'expensive', 'price', 'sale', 'дорог', 'дешев', 'покажи', 'найди', 'отсорт',
    'цена', 'скид', 'распрод',
  ];

  return collectionWords.some((word) => text.includes(word)) && browseWords.some((word) => text.includes(word));
}

function looksLikeGenericBrowseQuestion(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  const patterns = [
    /what products do you have/, /what do you have/, /what can i buy/,
    /what is available/, /what's available/, /show me (your )?products$/,
    /show products$/, /какие товары (у вас )?есть/, /что у вас есть/,
    /что можно купить/, /какие у вас товары/, /покажи товары$/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function looksLikeCategoryMenuDecision(decision) {
  const response = String(decision?.response || '').toLowerCase();
  if (decision?.tool) return false;

  return (
    response.includes('daily shoes') &&
    response.includes('running shoes') &&
    response.includes('training shoes') &&
    response.includes('football') &&
    response.includes('sale')
  );
}

function looksLikeCategoryChoiceDecision(decision) {
  const response = String(decision?.response || '').toLowerCase();
  if (decision?.tool) return false;

  const mentionsCategories =
    response.includes('daily shoes') &&
    response.includes('running shoes') &&
    response.includes('training shoes') &&
    response.includes('football') &&
    response.includes('sale');

  const looksLikePrompt =
    response.includes('choose a category') ||
    response.includes('choose category') ||
    response.includes('which category') ||
    response.includes('выберите категорию') ||
    response.includes('какая категория') ||
    response.includes('какие категории');

  return mentionsCategories || looksLikePrompt;
}

function isInitialCategoryMenuText(text) {
  const value = String(text || '').toLowerCase();
  return (
    value.includes('daily shoes') &&
    value.includes('running shoes') &&
    value.includes('training shoes') &&
    value.includes('football') &&
    value.includes('sale') &&
    value.includes('6.')
  );
}

function getLastAssistantText(history) {
  if (!Array.isArray(history)) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role === 'assistant' && typeof item?.text === 'string' && item.text.trim()) {
      return item.text.trim();
    }
  }
  return '';
}

function normalizeProductId(rawProductId) {
  const value = String(rawProductId ?? '').trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;
  const gidMatch = value.match(/gid:\/\/shopify\/Product\/(\d+)/);
  if (gidMatch?.[1]) return gidMatch[1];
  return null;
}

function normalizeCategory(rawCategory) {
  const value = String(rawCategory || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'daily shoes') return 'Daily Shoes';
  if (value === 'running shoes') return 'Running Shoes';
  if (value === 'training shoes' || value === 'gym shoes') return 'Training Shoes';
  if (
    value === 'football & court shoes' ||
    value === 'football and court shoes' ||
    value === 'field & court shoes' ||
    value === 'field and court shoes' ||
    value === 'sport shoes'
  ) return 'Football & Court Shoes';
  if (value === 'sale' || value === 'sales products' || value === 'sale products') return 'Sale';
  return null;
}

function getCategoryTag(category) {
  const normalizedCategory = normalizeCategory(category);
  if (normalizedCategory === 'Daily Shoes') return 'daily-shoes';
  if (normalizedCategory === 'Running Shoes') return 'running-shoes';
  if (normalizedCategory === 'Training Shoes') return 'training-shoes';
  if (normalizedCategory === 'Football & Court Shoes') return 'football-court-shoes';
  return null;
}

function productHasTag(product, expectedTag) {
  const normalizedTag = String(expectedTag || '').trim().toLowerCase();
  if (!normalizedTag) return false;

  const tags = Array.isArray(product?.tags) ? product.tags : [];
  return tags.some((tag) => String(tag || '').trim().toLowerCase() === normalizedTag);
}

function normalizeScreen(rawScreen) {
  const value = String(rawScreen || '').trim().toUpperCase();
  if (!value) return null;
  const knownScreens = new Set([
    SCREEN_ENTRY, SCREEN_PROMO_INFO, SCREEN_PRODUCT_LIST, SCREEN_PRODUCT_FOCUS,
    SCREEN_VARIANT_SELECTION, SCREEN_PRODUCT_READY, SCREEN_POST_CART_RECONCILE,
    SCREEN_POST_CART_UNLOCK_PENDING, SCREEN_POST_CART_UNLOCKED, SCREEN_EMAIL_CAPTURE,
    SCREEN_SERVICES_ENTRY, SCREEN_SERVICES_SERVICES, SCREEN_SERVICES_PRICES,
    SCREEN_SERVICES_PROJECTS, SCREEN_SERVICES_ABOUT, SCREEN_SERVICES_CONTACTS, SCREEN_UNKNOWN,
  ]);
  return knownScreens.has(value) ? value : null;
}

function normalizeVariantId(rawVariantId) {
  const value = String(rawVariantId ?? '').trim();
  if (!value) return null;
  const gidMatch = value.match(/gid:\/\/shopify\/ProductVariant\/(\d+)/);
  if (gidMatch?.[1]) return `gid://shopify/ProductVariant/${gidMatch[1]}`;
  if (/^\d+$/.test(value)) return `gid://shopify/ProductVariant/${value}`;
  return value;
}

function toProductGid(rawProductId) {
  const productId = normalizeProductId(rawProductId);
  return productId ? `gid://shopify/Product/${productId}` : null;
}

function normalizeCollectionId(rawCollectionId) {
  const value = String(rawCollectionId ?? '').trim();
  if (!value) return null;
  const gidMatch = value.match(/gid:\/\/shopify\/Collection\/(\d+)/);
  if (gidMatch?.[1]) return `gid://shopify/Collection/${gidMatch[1]}`;
  if (/^\d+$/.test(value)) return `gid://shopify/Collection/${value}`;
  return null;
}

function parseMainCategoryRef(rawRef) {
  const value = String(rawRef || '').trim();
  if (!value) return null;

  const collectionId = normalizeCollectionId(value);
  if (collectionId) {
    return { type: 'id', value: collectionId };
  }

  return { type: 'handle', value };
}

function normalizeClientState(rawState) {
  const safeState = rawState && typeof rawState === 'object' ? rawState : {};
  const screen = normalizeScreen(safeState.screen);
  const visibleProducts = Array.isArray(safeState.visible_products)
    ? safeState.visible_products
      .map((item, index) => ({
        index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index + 1,
        product_id: normalizeProductId(item?.product_id),
        title: String(item?.title || '').trim() || null,
      }))
      .filter((item) => item.product_id)
    : [];
  const variantOptions = Array.isArray(safeState.variant_options)
    ? safeState.variant_options
      .map((item, index) => ({
        index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index + 1,
        product_id: normalizeProductId(item?.product_id),
        variant_id: normalizeVariantId(item?.variant_id),
        title: String(item?.title || '').trim() || null,
        options: Array.isArray(item?.options)
          ? item.options
            .map((option) => ({ name: String(option?.name || '').trim(), value: String(option?.value || '').trim() }))
            .filter((option) => option.name && option.value)
          : [],
      }))
      .filter((item) => item.variant_id)
    : [];
  const selectedVariant = safeState.selected_variant && typeof safeState.selected_variant === 'object'
    ? {
        product_id: normalizeProductId(safeState.selected_variant.product_id),
        variant_id: normalizeVariantId(safeState.selected_variant.variant_id),
        title: String(safeState.selected_variant.title || '').trim() || null,
        options: Array.isArray(safeState.selected_variant.options)
          ? safeState.selected_variant.options
            .map((option) => ({ name: String(option?.name || '').trim(), value: String(option?.value || '').trim() }))
            .filter((option) => option.name && option.value)
          : [],
      }
    : null;
  const cartState = safeState.cart_state && typeof safeState.cart_state === 'object'
    ? {
        unique_products_count: Number.isFinite(Number(safeState.cart_state.unique_products_count))
          ? Number(safeState.cart_state.unique_products_count)
          : null,
      }
    : null;

  return {
    screen,
    category: normalizeCategory(safeState.category),
    visible_products: visibleProducts,
    focus_product_id: normalizeProductId(safeState.focus_product_id),
    focus_product_title: String(safeState.focus_product_title || '').trim() || null,
    variant_options: variantOptions,
    selected_variant: selectedVariant,
    cart_state: cartState,
  };
}

function extractNumericSelection(message) {
  const value = String(message || '').trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function createTraceContext({ message, history, clientState, language }) {
  return {
    trace_id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    started_at: Date.now(),
    request: {
      message,
      history_count: Array.isArray(history) ? history.length : 0,
      language,
      client_state: clientState,
    },
    steps: [],
  };
}

function pushTraceStep(trace, step, details = {}) {
  if (!trace || !Array.isArray(trace.steps)) return;
  trace.steps.push({ at: Date.now(), step, ...details });
}

function buildTraceDebug(trace) {
  if (!trace) return {};
  return { trace_id: trace.trace_id, started_at: trace.started_at, request: trace.request, steps: trace.steps };
}

function buildDebugPayload(screen, extras = {}) {
  return { screen, ...extras };
}

function renderServicesEntryResponse(language = 'en') {
  if (language === 'ru') {
    return [
      '<p>Это AI-консультант по нашим Shopify-услугам.</p>',
      '<p>Что вас интересует?</p>',
      '<ul>',
      '  <li>1. Услуги</li>',
      '  <li>2. Проекты</li>',
      '  <li>3. О нас</li>',
      '  <li>4. Контакты</li>',
      '</ul>',
      '<p>Ответьте номером.</p>',
    ].join('\n');
  }

  return [
    '<p>This is an AI assistant for our Shopify services.</p>',
    '<p>What would you like to explore?</p>',
    '<ul>',
    '  <li>1. Services</li>',
    '  <li>2. Projects</li>',
    '  <li>3. About us</li>',
    '  <li>4. Contacts</li>',
    '</ul>',
    '<p>Reply with a number.</p>',
  ].join('\n');
}

function normalizeServicesIntentText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function detectServicesIntent(message) {
  const text = normalizeServicesIntentText(message);
  if (!text) return null;

  const exactIntentMap = {
    services: 'services', prices: 'prices', projects: 'projects',
    'about us': 'about', about: 'about', contacts: 'contacts', contact: 'contacts',
  };

  if (exactIntentMap[text]) return exactIntentMap[text];

  const patterns = {
    about: [/\babout us\b/, /\bwho are you\b/, /\bwhat kind of team\b/, /\btell me about (you|your team|the company)\b/, /\babout (you|your team|the company)\b/, /кто вы/, /что вы за компания/, /расскажите о себе/, /кто вы такие/, /о вас/, /о команде/, /чем вы занимаетесь/],
    services: [/\bservices\b/, /\bwhat services\b/, /\bwhat do you do\b/, /\bhow can you help\b/, /\bwhat can you do\b/, /\bshopify services\b/, /\bai implementation\b/, /\bcro\b/, /\bconversion optimization\b/, /\btheme development\b/, /\breplatforming\b/, /\bwoocommerce\b/, /\bmagento\b/, /какие услуги/, /что вы делаете/, /что вы умеете/, /что вы можете/, /что вы можете сделать/, /чем можете помочь/, /что умеете/, /ai implementation/, /theme development/, /replatforming/, /миграц/, /woocommerce/, /magento/],
    prices: [/\bprice\b/, /\bprices\b/, /\bcost\b/, /\brate\b/, /\bhourly\b/, /\bhow much\b/, /цены/, /сколько стоит/, /стоимость/, /прайс/, /час работы/],
    projects: [/\bprojects\b/, /\bcase studies\b/, /\bexamples\b/, /\bportfolio\b/, /\bwhat have you built\b/, /проекты/, /кейсы/, /примеры/, /портфолио/, /что вы делали/],
    contacts: [/\bcontact\b/, /\bcontacts\b/, /\bget in touch\b/, /\breach you\b/, /контакты/, /связаться/, /как вас найти/, /как с вами связаться/],
  };

  if (patterns.prices.some((pattern) => pattern.test(text))) return 'prices';
  if (patterns.projects.some((pattern) => pattern.test(text))) return 'projects';
  if (patterns.contacts.some((pattern) => pattern.test(text))) return 'contacts';
  if (patterns.services.some((pattern) => pattern.test(text))) return 'services';
  if (patterns.about.some((pattern) => pattern.test(text))) return 'about';
  return null;
}

function renderServicesIntentResponse(intent, language = 'en') {
  if (language === 'ru') {
    if (intent === 'about') return '<p>Мы команда сертифицированных Shopify-разработчиков. Помогаем брендам строить производительные eCommerce-решения, улучшать конверсию и внедрять AI в storefront и сервисные сценарии.</p>';
    if (intent === 'services') return '<p>Мы помогаем Shopify-брендам с AI Implementation, CRO, Theme Development и Replatforming с WooCommerce или Magento на Shopify.</p>';
    if (intent === 'prices') return '<p>Стартовые цены уже указаны внутри карточек услуг, поэтому я открою раздел с услугами.</p>';
    if (intent === 'projects') return '<p>Ниже вы можете посмотреть выбранные проекты и примеры нашей работы.</p>';
    if (intent === 'contacts') return '<p>Ниже вы можете оставить контактные данные или выбрать удобный канал связи.</p>';
    return renderServicesEntryResponse(language);
  }

  if (intent === 'about') return '<p>We are a team of certified Shopify developers focused on high-performance ecommerce, AI implementation, CRO, theme development, and Shopify replatforming.</p>';
  if (intent === 'services') return '<p>We help Shopify brands with AI Implementation, CRO, Theme Development, and Replatforming from WooCommerce or Magento to Shopify.</p>';
  if (intent === 'prices') return '<p>Starting prices are already shown inside the service cards, so I will open Services.</p>';
  if (intent === 'projects') return '<p>Below you can explore selected projects and examples of our work.</p>';
  if (intent === 'contacts') return '<p>Below you can leave your contact details or use one of our preferred contact channels.</p>';
  return renderServicesEntryResponse(language);
}

function renderServicesScreenResponse(screen, language = 'en') {
  if (language === 'ru') {
    if (screen === SCREEN_SERVICES_SERVICES) return '<p>Здесь будет блок с описанием наших Shopify-услуг и краткое пояснение от агента.</p>';
    if (screen === SCREEN_SERVICES_PROJECTS) return '<p>Здесь будет блок с реализованными проектами и кейсами.</p>';
    if (screen === SCREEN_SERVICES_ABOUT) return '<p>Здесь будет блок о нас: кто мы, как работаем и в чём наша сила.</p>';
    if (screen === SCREEN_SERVICES_CONTACTS) return '<p>Здесь будет блок с контактами и следующим шагом для связи.</p>';
    return renderServicesEntryResponse(language);
  }

  if (screen === SCREEN_SERVICES_SERVICES) return '<p>This block will present our Shopify services with a short assistant summary.</p>';
  if (screen === SCREEN_SERVICES_PROJECTS) return '<p>This block will present selected projects and case studies.</p>';
  if (screen === SCREEN_SERVICES_ABOUT) return '<p>This block will explain who we are, how we work, and what makes us effective.</p>';
  if (screen === SCREEN_SERVICES_CONTACTS) return '<p>This block will present contact options and the next step to reach us.</p>';
  return renderServicesEntryResponse(language);
}

function handleServicesDeterministicInput({ message, language, clientState }) {
  const selection = extractNumericSelection(message);
  const currentScreen = normalizeScreen(clientState?.screen) || SCREEN_SERVICES_ENTRY;
  const semanticIntent = detectServicesIntent(message);

  if (!selection && semanticIntent) {
    const intentScreenMap = {
      about: SCREEN_SERVICES_ABOUT, services: SCREEN_SERVICES_SERVICES, prices: SCREEN_SERVICES_SERVICES,
      projects: SCREEN_SERVICES_PROJECTS, contacts: SCREEN_SERVICES_CONTACTS,
    };
    const nextScreen = intentScreenMap[semanticIntent] || SCREEN_SERVICES_ENTRY;
    const responseText = renderServicesIntentResponse(semanticIntent, language);
    return {
      screen: nextScreen, text: responseText,
      decision: { tool: null, parameters: null, response: responseText },
      actions: [], tool_results: [], screen_state: { screen: nextScreen },
      debug: { route: 'services_semantic_intent', assistant_type: 'services', semantic_intent: semanticIntent },
    };
  }

  if (!selection && currentScreen === SCREEN_SERVICES_ENTRY) {
    return {
      screen: SCREEN_SERVICES_ENTRY, text: renderServicesEntryResponse(language),
      decision: { tool: null, parameters: null, response: renderServicesEntryResponse(language) },
      actions: [], tool_results: [], screen_state: { screen: SCREEN_SERVICES_ENTRY },
      debug: { route: 'services_entry_default' },
    };
  }

  if (!selection) return null;

  const servicesMap = {
    1: SCREEN_SERVICES_SERVICES,
    2: SCREEN_SERVICES_PRICES,
    3: SCREEN_SERVICES_PROJECTS,
    4: SCREEN_SERVICES_ABOUT,
    5: SCREEN_SERVICES_CONTACTS,
  };
  const nextScreen = servicesMap[selection];
  if (!nextScreen) return null;

  return {
    screen: nextScreen, text: renderServicesScreenResponse(nextScreen, language),
    decision: { tool: null, parameters: null, response: renderServicesScreenResponse(nextScreen, language) },
    actions: [], tool_results: [], screen_state: { screen: nextScreen },
    debug: { route: 'services_numeric_selection', assistant_type: 'services' },
  };
}

function isProductOnSale(product) {
  const variantNodes = Array.isArray(product?.variants?.nodes) ? product.variants.nodes : Array.isArray(product?.variants) ? product.variants : [];
  return variantNodes.some((variant) => {
    const compareAt = Number(variant?.compareAtPrice?.amount ?? variant?.compare_at_price);
    const price = Number(variant?.price?.amount ?? variant?.price);
    return Number.isFinite(compareAt) && Number.isFinite(price) && compareAt > price;
  });
}

async function storefrontRequest(query, variables = {}) {
  const response = await fetch(storefrontEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': storefrontAccessToken },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify Storefront API HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (Array.isArray(json?.errors) && json.errors.length) {
    throw new Error(json.errors.map((error) => error.message).join(' | '));
  }

  return json?.data || {};
}

async function getProductsFromMainCategory({ first }) {
  const ref = parseMainCategoryRef(mainCategoryRef);
  if (!ref) return { source: { mode: 'missing_main_category', ref: mainCategoryRef }, nodes: [] };

  if (ref.type === 'id') {
    const data = await storefrontRequest(MAIN_COLLECTION_PRODUCTS_BY_ID_QUERY, { id: ref.value, first });
    return {
      source: { mode: 'main_category_id', ref: ref.value, handle: data?.node?.handle || null, title: data?.node?.title || null },
      nodes: Array.isArray(data?.node?.products?.nodes) ? data.node.products.nodes : [],
    };
  }

  const data = await storefrontRequest(MAIN_COLLECTION_PRODUCTS_BY_HANDLE_QUERY, { handle: ref.value, first });
  return {
    source: { mode: 'main_category_handle', ref: ref.value, handle: data?.collection?.handle || null, title: data?.collection?.title || null },
    nodes: Array.isArray(data?.collection?.products?.nodes) ? data.collection.products.nodes : [],
  };
}

async function getStorefrontDebugSummary() {
  const mainCategory = parseMainCategoryRef(mainCategoryRef);
  const productsData = await storefrontRequest(DEBUG_PRODUCTS_QUERY, { first: 5 });
  const topLevelProducts = Array.isArray(productsData?.products?.nodes) ? productsData.products.nodes : [];

  const mainCategoryResult = mainCategoryRef
    ? await getProductsFromMainCategory({ first: 5 })
    : { source: { mode: 'missing_main_category', ref: mainCategoryRef }, nodes: [] };

  return {
    model, storefront_endpoint: storefrontEndpoint, main_category_env: mainCategoryRef, main_category_parsed: mainCategory,
    top_level_products_count: topLevelProducts.length,
    top_level_products: topLevelProducts.map((product) => ({
      id: normalizeProductId(product?.id), title: String(product?.title || '').trim() || null,
      productType: String(product?.productType || '').trim() || null, vendor: String(product?.vendor || '').trim() || null,
      tags: Array.isArray(product?.tags) ? product.tags : [],
    })),
    main_category_source: mainCategoryResult?.source || null,
    main_category_products_count: Array.isArray(mainCategoryResult?.nodes) ? mainCategoryResult.nodes.length : 0,
    main_category_products: Array.isArray(mainCategoryResult?.nodes)
      ? mainCategoryResult.nodes.map((product) => ({
          id: normalizeProductId(product?.id), title: String(product?.title || '').trim() || null,
          productType: String(product?.productType || '').trim() || null, vendor: String(product?.vendor || '').trim() || null,
          tags: Array.isArray(product?.tags) ? product.tags : [],
        }))
      : [],
  };
}

function buildShopifySearchQuery({ category }) {
  const normalizedCategory = normalizeCategory(category);
  const categoryTag = getCategoryTag(normalizedCategory);
  const queryParts = [];
  if (categoryTag) queryParts.push(`tag:'${categoryTag.replace(/'/g, "\\'")}'`);
  return queryParts.join(' AND ') || null;
}

function matchesBrand(product, brand) {
  const normalizedBrand = String(brand || '').trim().toLowerCase();
  if (!normalizedBrand) return true;
  const vendor = String(product?.vendor || '').trim().toLowerCase();
  if (vendor === normalizedBrand) return true;
  const tags = Array.isArray(product?.tags) ? product.tags : [];
  if (tags.some((tag) => String(tag || '').trim().toLowerCase() === normalizedBrand)) return true;
  const title = String(product?.title || '').trim().toLowerCase();
  if (title.includes(normalizedBrand)) return true;
  return false;
}

function matchesAnyBrand(product, brands) {
  const normalizedBrands = Array.isArray(brands) ? brands.filter(Boolean) : [];
  if (!normalizedBrands.length) return true;
  return normalizedBrands.some((brand) => matchesBrand(product, brand));
}

function getProductMinPrice(product) {
  const variantNodes = Array.isArray(product?.variants?.nodes) ? product.variants.nodes : Array.isArray(product?.variants) ? product.variants : [];
  const prices = variantNodes.map((variant) => Number(variant?.price?.amount ?? variant?.price)).filter((value) => Number.isFinite(value));
  if (!prices.length) return null;
  return Math.min(...prices);
}

function sortProducts(products, sort) {
  const safeProducts = Array.isArray(products) ? [...products] : [];
  const sortMode = String(sort || '').trim();
  if (sortMode === 'price_asc') return safeProducts.sort((left, right) => (getProductMinPrice(left) ?? Number.POSITIVE_INFINITY) - (getProductMinPrice(right) ?? Number.POSITIVE_INFINITY));
  if (sortMode === 'price_desc') return safeProducts.sort((left, right) => (getProductMinPrice(right) ?? Number.NEGATIVE_INFINITY) - (getProductMinPrice(left) ?? Number.NEGATIVE_INFINITY));
  return safeProducts;
}

async function getProductsForCategory({ category, brands, limit, minPrice, maxPrice, sort }) {
  const normalizedCategory = normalizeCategory(category);
  const categoryTag = getCategoryTag(normalizedCategory);
  const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_COLLECTION_LIMIT;
  const needsWideFetch = normalizedCategory === 'Sale' || minPrice != null || maxPrice != null || !normalizedCategory;
  const first = needsWideFetch ? Math.max(requestedLimit, SALE_COLLECTION_FETCH_LIMIT) : requestedLimit;
  const query = buildShopifySearchQuery({ category: normalizedCategory });

  let nodes = [];
  let source = { mode: 'search_query', ref: query };
  if (normalizedCategory == null && mainCategoryRef) {
    const mainCategoryResult = await getProductsFromMainCategory({ first });
    nodes = Array.isArray(mainCategoryResult?.nodes) ? mainCategoryResult.nodes : [];
    source = mainCategoryResult?.source || { mode: 'main_category_unknown', ref: mainCategoryRef };
  } else {
    const data = await storefrontRequest(COLLECTION_PRODUCTS_QUERY, { first, query });
    nodes = Array.isArray(data?.products?.nodes) ? data.products.nodes : [];
  }

  let filteredNodes = normalizedCategory === 'Sale' ? nodes.filter((product) => isProductOnSale(product)) : nodes;
  if (categoryTag) filteredNodes = filteredNodes.filter((product) => productHasTag(product, categoryTag));
  if (Array.isArray(brands) && brands.length) filteredNodes = filteredNodes.filter((product) => matchesAnyBrand(product, brands));

  if (minPrice != null || maxPrice != null) {
    filteredNodes = filteredNodes.filter((product) => {
      const minProductPrice = getProductMinPrice(product);
      if (!Number.isFinite(minProductPrice)) return false;
      if (minPrice != null && minProductPrice < minPrice) return false;
      if (maxPrice != null && minProductPrice > maxPrice) return false;
      return true;
    });
  }

  filteredNodes = sortProducts(filteredNodes, sort);

  return { products: filteredNodes.slice(0, requestedLimit), source };
}

async function getProductDetails(productId) {
  const gid = toProductGid(productId);
  if (!gid) return null;
  const data = await storefrontRequest(PRODUCT_DETAILS_QUERY, { id: gid });
  return data?.product || null;
}

async function buildShowProductCollectionResult(parameters = {}) {
  const normalizedCategory = normalizeCategory(parameters?.category);
  const minPrice = normalizePriceFilter(parameters?.min_price);
  const maxPrice = normalizePriceFilter(parameters?.max_price);
  const brands = normalizeBrands(parameters?.brands, parameters?.brand);
  const collectionResult = await getProductsForCategory({
    category: normalizedCategory, brands, limit: parameters?.limit, minPrice, maxPrice, sort: parameters?.sort || null,
  });
  const products = Array.isArray(collectionResult?.products) ? collectionResult.products : [];
  const productIds = products.map((product) => {
    const match = String(product?.id || '').match(/gid:\/\/shopify\/Product\/(\d+)/);
    return match?.[1] || null;
  }).filter(Boolean);

  return {
    ok: Boolean(productIds.length), category: normalizedCategory, brands, min_price: minPrice, max_price: maxPrice,
    source: collectionResult?.source || null, product_ids: productIds,
    visible_products: products.slice(0, 6).map((product, index) => ({
      index: index + 1, product_id: normalizeProductId(product?.id), title: String(product?.title || '').trim() || null,
    })),
    total_matches: products.length,
    action: productIds.length ? { type: 'client_tool', name: 'setProductCollection', parameters: { products: productIds } } : null,
  };
}

async function buildSetFocusProductResult(parameters = {}) {
  const productId = normalizeProductId(parameters?.product_id);
  const product = productId ? await getProductDetails(productId) : null;
  const variantNodes = Array.isArray(product?.variants?.nodes) ? product.variants.nodes : [];
  const availableVariants = variantNodes.filter((variant) => Boolean(variant?.availableForSale));
  const defaultVariant = availableVariants[0] || variantNodes[0] || null;

  return {
    ok: Boolean(productId && product), product_id: productId, product_title: String(product?.title || '').trim() || null,
    selected_variant: defaultVariant
      ? {
          product_id: productId, variant_id: normalizeVariantId(defaultVariant?.id), title: String(defaultVariant?.title || '').trim() || null,
          options: Array.isArray(defaultVariant?.selectedOptions)
            ? defaultVariant.selectedOptions.map((option) => ({ name: String(option?.name || '').trim(), value: String(option?.value || '').trim() })).filter((option) => option.name && option.value)
            : [],
        }
      : null,
    variant_options: availableVariants.map((variant, index) => ({
      index: index + 1, product_id: productId, variant_id: normalizeVariantId(variant?.id), title: String(variant?.title || '').trim() || `Variant ${index + 1}`,
      options: Array.isArray(variant?.selectedOptions)
        ? variant.selectedOptions.map((option) => ({ name: String(option?.name || '').trim(), value: String(option?.value || '').trim() })).filter((option) => option.name && option.value)
        : [],
    })),
    action: productId ? { type: 'client_tool', name: 'setFocusProduct', parameters: { product_id: productId } } : null,
    error: !productId ? 'Missing product_id for setFocusProduct' : !product ? 'Product not found' : null,
  };
}

async function executeToolSelection(decision) {
  if (decision?.tool === 'showProductCollection') return buildShowProductCollectionResult(decision?.parameters || {});
  if (decision?.tool === 'setFocusProduct') return buildSetFocusProductResult(decision?.parameters || {});
  return { ok: false, error: `Unsupported tool: ${decision?.tool || 'unknown'}`, action: null };
}

async function requestStructuredDecision({ promptText, history, message, clientState }) {
  const response = await client.responses.create({
    model,
    input: buildRoutingInput({ history, message, clientState, promptText }),
    text: { format: { type: 'json_schema', name: 'storefront_decision', strict: true, schema: STOREFRONT_DECISION_SCHEMA } },
  });
  return { response, decision: normalizeDecision(parseDecisionFromOutputText(response.output_text)) };
}

function normalizeCollectionDecision(decision) {
  const safeDecision = decision && typeof decision === 'object' ? decision : {};
  const rawTool = typeof safeDecision.tool === 'string' ? safeDecision.tool.trim() : '';
  const tool = rawTool === 'showProductCollection' ? rawTool : null;
  const rawParameters = safeDecision.parameters && typeof safeDecision.parameters === 'object' ? safeDecision.parameters : {};

  return {
    tool,
    parameters: tool
      ? {
          category: normalizeCategory(rawParameters.category), brands: normalizeBrands(rawParameters.brands, rawParameters.brand),
          brand: typeof rawParameters.brand === 'string' && rawParameters.brand.trim() ? rawParameters.brand.trim() : null,
          min_price: normalizePriceFilter(rawParameters.min_price), max_price: normalizePriceFilter(rawParameters.max_price),
          sale_only: typeof rawParameters.sale_only === 'boolean' ? rawParameters.sale_only : null,
          limit: Number.isInteger(rawParameters.limit) && rawParameters.limit > 0 ? rawParameters.limit : null,
          sort: ['featured', 'price_asc', 'price_desc', 'newest'].includes(String(rawParameters.sort || '').trim()) ? String(rawParameters.sort).trim() : null,
          product_id: null,
        }
      : null,
    response: null,
  };
}

async function requestCollectionDecision({ history, message, clientState }) {
  const response = await client.responses.create({
    model, input: buildRoutingInput({ history, message, clientState, promptText: COLLECTION_RECOVERY_PROMPT }), tools: [SHOW_PRODUCT_COLLECTION_TOOL], tool_choice: 'auto',
  });
  const functionCall = extractFunctionCall(response, ['showProductCollection']);
  return {
    response, raw_output_text: JSON.stringify(response.output || []),
    decision: functionCall ? normalizeCollectionDecision({ tool: 'showProductCollection', parameters: functionCall.arguments }) : null,
  };
}

async function recoverCollectionDecision({ history, message, clientState }) {
  const { response, decision, raw_output_text } = await requestCollectionDecision({ history, message, clientState });
  if (decision?.tool !== 'showProductCollection') return { response, decision: null, raw_output_text };
  return { response, decision, raw_output_text };
}

async function forceCollectionDecision({ history, message, clientState }) {
  const response = await client.responses.create({
    model, input: buildRoutingInput({ history, message, clientState, promptText: COLLECTION_FORCED_PROMPT }), tools: [SHOW_PRODUCT_COLLECTION_TOOL],
    tool_choice: { type: 'function', name: 'showProductCollection' },
  });
  const functionCall = extractFunctionCall(response, ['showProductCollection']);
  return {
    response, raw_output_text: JSON.stringify(response.output || []),
    decision: functionCall ? normalizeCollectionDecision({ tool: 'showProductCollection', parameters: functionCall.arguments }) : null,
  };
}

function resolveResponseScreen({ decision, toolResult }) {
  if (decision?.tool === 'showProductCollection' && toolResult?.action?.name === 'setProductCollection') return SCREEN_PRODUCT_LIST;
  if (decision?.tool === 'setFocusProduct' && toolResult?.action?.name === 'setFocusProduct') return SCREEN_PRODUCT_FOCUS;
  if (looksLikeCategoryMenuDecision(decision)) return SCREEN_ENTRY;
  return SCREEN_UNKNOWN;
}

function createSuccessPayload({ modelName, screen, text = '', responseId = null, historyCount = 0, decision = null, actions = [], toolResults, screenState = null, debug = {}, trace = null }) {
  const normalizedText = LOCAL_RENDERED_SCREENS.has(screen) ? '' : text;
  const payload = { ok: true, model: modelName, screen, screen_state: screenState, debug: buildDebugPayload(screen, { ...debug, ...buildTraceDebug(trace) }), text: normalizedText, response_id: responseId, history_count: historyCount, decision, actions };
  if (toolResults) payload.tool_results = toolResults;
  return payload;
}

async function handleDeterministicScreenInput({ message, language, clientState }) {
  const selection = extractNumericSelection(message);
  if (selection && (clientState?.screen === SCREEN_ENTRY || clientState?.screen === SCREEN_PROMO_INFO)) {
    if (selection === 6 && clientState.screen === SCREEN_ENTRY) {
      return {
        screen: SCREEN_PROMO_INFO, text: renderPromoInfoResponse(language),
        decision: { tool: null, parameters: null, response: renderPromoInfoResponse(language) },
        actions: [], screen_state: { screen: SCREEN_PROMO_INFO }, debug: { route: 'entry_to_promo_info' },
      };
    }
    const categoryMap = { 1: 'Daily Shoes', 2: 'Running Shoes', 3: 'Training Shoes', 4: 'Football & Court Shoes', 5: 'Sale' };
    const category = categoryMap[selection];
    if (category) {
      const toolResult = await buildShowProductCollectionResult({ category });
      return {
        screen: SCREEN_PRODUCT_LIST, text: renderProductListResponse(toolResult.visible_products, language),
        decision: { tool: 'showProductCollection', parameters: { category, brands: null, brand: null, min_price: null, max_price: null, sale_only: category === 'Sale', limit: null, sort: null, product_id: null }, response: renderProductListResponse(toolResult.visible_products, language) },
        actions: toolResult.action ? [toolResult.action] : [], tool_results: [toolResult], screen_state: { screen: SCREEN_PRODUCT_LIST, category, visible_products: toolResult.visible_products }, debug: { route: 'entry_category_selection' },
      };
    }
  }

  if (!selection || !clientState?.screen) return null;

  if (clientState.screen === SCREEN_PRODUCT_LIST) {
    const selectedProduct = clientState.visible_products.find((item) => item.index === selection);
    if (!selectedProduct?.product_id) return null;
    const toolResult = await buildSetFocusProductResult({ product_id: selectedProduct.product_id });
    if (!toolResult.ok || !toolResult.action) return null;
    return {
      screen: SCREEN_PRODUCT_FOCUS, text: renderProductFocusResponse(language, toolResult.product_title || selectedProduct.title),
      decision: { tool: 'setFocusProduct', parameters: { category: null, brands: null, brand: null, min_price: null, max_price: null, sale_only: null, limit: null, sort: null, product_id: selectedProduct.product_id }, response: renderProductFocusResponse(language, toolResult.product_title || selectedProduct.title) },
      actions: [toolResult.action], tool_results: [toolResult], screen_state: { screen: SCREEN_PRODUCT_FOCUS, category: clientState.category, focus_product_id: toolResult.product_id, focus_product_title: toolResult.product_title || selectedProduct.title, selected_variant: toolResult.selected_variant, variant_options: toolResult.variant_options }, debug: { route: 'product_list_numeric_focus' },
    };
  }

  if (clientState.screen === SCREEN_PRODUCT_FOCUS) {
    if (selection === 1) return { screen: SCREEN_VARIANT_SELECTION, text: renderVariantSelectionResponse(clientState.variant_options, language), decision: { tool: null, parameters: null, response: renderVariantSelectionResponse(clientState.variant_options, language) }, actions: [], screen_state: { screen: SCREEN_VARIANT_SELECTION, focus_product_id: clientState.focus_product_id, focus_product_title: clientState.focus_product_title, variant_options: clientState.variant_options, selected_variant: clientState.selected_variant }, debug: { route: 'product_focus_to_variant_selection' } };
    if (selection === 3) {
      const toolResult = await buildShowProductCollectionResult({ category: 'Sale' });
      return { screen: SCREEN_PRODUCT_LIST, text: renderProductListResponse(toolResult.visible_products, language), decision: { tool: 'showProductCollection', parameters: { category: 'Sale', brands: null, brand: null, min_price: null, max_price: null, sale_only: true, limit: null, sort: null, product_id: null }, response: renderProductListResponse(toolResult.visible_products, language) }, actions: toolResult.action ? [toolResult.action] : [], tool_results: [toolResult], screen_state: { screen: SCREEN_PRODUCT_LIST, category: toolResult.category || 'Sale', visible_products: toolResult.visible_products }, debug: { route: 'product_focus_show_sale' } };
    }
    if (selection === 4) {
      const category = clientState.category;
      if (!category) return { screen: SCREEN_ENTRY, text: renderCategoryMenuResponse(language), decision: { tool: null, parameters: null, response: renderCategoryMenuResponse(language) }, actions: [], screen_state: { screen: SCREEN_ENTRY }, debug: { route: 'product_focus_back_to_entry' } };
      const toolResult = await buildShowProductCollectionResult({ category });
      return { screen: SCREEN_PRODUCT_LIST, text: renderProductListResponse(toolResult.visible_products, language), decision: { tool: 'showProductCollection', parameters: { category, brands: null, brand: null, min_price: null, max_price: null, sale_only: category === 'Sale', limit: null, sort: null, product_id: null }, response: renderProductListResponse(toolResult.visible_products, language) }, actions: toolResult.action ? [toolResult.action] : [], tool_results: [toolResult], screen_state: { screen: SCREEN_PRODUCT_LIST, category: toolResult.category || category, visible_products: toolResult.visible_products }, debug: { route: 'product_focus_back_to_products' } };
    }
    if (selection === 2 && clientState.focus_product_id) {
      const selectedVariant = clientState.selected_variant;
      const action = { type: 'client_tool', name: 'cartAddItems', parameters: { items: [{ product_id: clientState.focus_product_id, quantity: 1, options: Array.isArray(selectedVariant?.options) ? selectedVariant.options : [] }], openCart: true } };
      const uniqueCount = clientState.cart_state?.unique_products_count;
      if (Number.isFinite(uniqueCount)) {
        const postCartScreen = uniqueCount >= 2 ? SCREEN_POST_CART_UNLOCKED : SCREEN_POST_CART_UNLOCK_PENDING;
        const postCartText = uniqueCount >= 2 ? renderPostCartUnlockedResponse(language) : renderPostCartUnlockPendingResponse(language);
        return { screen: postCartScreen, text: postCartText, decision: { tool: null, parameters: null, response: postCartText }, actions: [action], screen_state: { screen: postCartScreen, cart_state: clientState.cart_state }, debug: { route: 'product_focus_add_to_cart_with_cart_state' } };
      }
      return { screen: SCREEN_POST_CART_RECONCILE, text: '', decision: { tool: null, parameters: null, response: '' }, actions: [action, { type: 'client_tool', name: 'getCartState', parameters: {} }], screen_state: { screen: SCREEN_POST_CART_RECONCILE, focus_product_id: clientState.focus_product_id }, debug: { route: 'product_focus_add_to_cart_reconcile' } };
    }
  }

  if (clientState.screen === SCREEN_VARIANT_SELECTION) {
    const selectedVariant = clientState.variant_options.find((item) => item.index === selection);
    if (!selectedVariant?.variant_id) return null;
    return { screen: SCREEN_PRODUCT_READY, text: renderProductReadyResponse(language, selectedVariant.title), decision: { tool: null, parameters: null, response: renderProductReadyResponse(language, selectedVariant.title) }, actions: [{ type: 'client_tool', name: 'setSelectedVariant', parameters: { product_id: selectedVariant.product_id, variant_id: selectedVariant.variant_id, options: selectedVariant.options } }], screen_state: { screen: SCREEN_PRODUCT_READY, focus_product_id: selectedVariant.product_id, selected_variant: { product_id: selectedVariant.product_id, variant_id: selectedVariant.variant_id, title: selectedVariant.title, options: selectedVariant.options }, focus_product_title: clientState.focus_product_title, variant_options: clientState.variant_options }, debug: { route: 'variant_selection_to_ready' } };
  }

  if (clientState.screen === SCREEN_PRODUCT_READY) {
    if (selection === 1 && clientState.focus_product_id) {
      const action = { type: 'client_tool', name: 'cartAddItems', parameters: { items: [{ product_id: clientState.focus_product_id, quantity: 1, options: Array.isArray(clientState.selected_variant?.options) ? clientState.selected_variant.options : [] }], openCart: true } };
      return { screen: SCREEN_POST_CART_RECONCILE, text: '', decision: { tool: null, parameters: null, response: '' }, actions: [action, { type: 'client_tool', name: 'getCartState', parameters: {} }], screen_state: { screen: SCREEN_POST_CART_RECONCILE, focus_product_id: clientState.focus_product_id, selected_variant: clientState.selected_variant }, debug: { route: 'product_ready_add_to_cart_reconcile' } };
    }
    if (selection === 2) return { screen: SCREEN_PRODUCT_FOCUS, text: renderProductFocusResponse(language, clientState.focus_product_title), decision: { tool: null, parameters: null, response: renderProductFocusResponse(language, clientState.focus_product_title) }, actions: [], screen_state: { screen: SCREEN_PRODUCT_FOCUS, focus_product_id: clientState.focus_product_id, focus_product_title: clientState.focus_product_title, selected_variant: clientState.selected_variant, variant_options: clientState.variant_options }, debug: { route: 'product_ready_back_to_focus' } };
  }

  if (clientState.screen === SCREEN_POST_CART_RECONCILE && Number.isFinite(clientState.cart_state?.unique_products_count)) {
    const nextScreen = clientState.cart_state.unique_products_count >= 2 ? SCREEN_POST_CART_UNLOCKED : SCREEN_POST_CART_UNLOCK_PENDING;
    const nextText = clientState.cart_state.unique_products_count >= 2 ? renderPostCartUnlockedResponse(language) : renderPostCartUnlockPendingResponse(language);
    return { screen: nextScreen, text: nextText, decision: { tool: null, parameters: null, response: nextText }, actions: [], screen_state: { screen: nextScreen, cart_state: clientState.cart_state }, debug: { route: 'post_cart_reconcile' } };
  }

  if (clientState.screen === SCREEN_POST_CART_UNLOCK_PENDING) {
    if (selection === 1) return { screen: SCREEN_ENTRY, text: renderCategoryMenuResponse(language), decision: { tool: null, parameters: null, response: renderCategoryMenuResponse(language) }, actions: [], screen_state: { screen: SCREEN_ENTRY }, debug: { route: 'post_cart_pending_continue' } };
    if (selection === 2) {
      const toolResult = await buildShowProductCollectionResult({ category: 'Sale' });
      return { screen: SCREEN_PRODUCT_LIST, text: renderProductListResponse(toolResult.visible_products, language), decision: { tool: 'showProductCollection', parameters: { category: 'Sale', brands: null, brand: null, min_price: null, max_price: null, sale_only: true, limit: null, sort: null, product_id: null }, response: renderProductListResponse(toolResult.visible_products, language) }, actions: toolResult.action ? [toolResult.action] : [], tool_results: [toolResult], screen_state: { screen: SCREEN_PRODUCT_LIST, category: 'Sale', visible_products: toolResult.visible_products }, debug: { route: 'post_cart_pending_sale_products' } };
    }
  }

  if (clientState.screen === SCREEN_POST_CART_UNLOCKED) {
    if (selection === 1) return { screen: SCREEN_EMAIL_CAPTURE, text: renderEmailCaptureResponse(language), decision: { tool: null, parameters: null, response: renderEmailCaptureResponse(language) }, actions: [], screen_state: { screen: SCREEN_EMAIL_CAPTURE }, debug: { route: 'post_cart_unlocked_email_capture' } };
    if (selection === 2) return { screen: SCREEN_ENTRY, text: renderCategoryMenuResponse(language), decision: { tool: null, parameters: null, response: renderCategoryMenuResponse(language) }, actions: [], screen_state: { screen: SCREEN_ENTRY }, debug: { route: 'post_cart_unlocked_continue' } };
  }

  return null;
}

// === EXPRESS ENDPOINTS ===

app.get('/health', (req, res) => {
  return res.status(200).json({ ok: true, model });
});

app.get('/debug/storefront', async (req, res) => {
  try {
    const summary = await getStorefrontDebugSummary();
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    console.error('[Storefront Debug Error]', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/ai', async (req, res) => {
  try {
    const body = req.body;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = Array.isArray(body?.messages) ? body.messages : [];
    const language = detectUserLanguage({ history, message });
    const clientState = normalizeClientState(body?.client_state);

    const agentRequestContext = buildAgentRequestContext({ payload: body, registry: agentRegistry, language, history, clientState });
    const assistantType = agentRequestContext.assistantType;
    const trace = createTraceContext({ message, history, clientState, language });

    pushTraceStep(trace, 'request_received', { model, assistant_type: assistantType, session_key: agentRequestContext.sessionKey });
    console.log('[AI Local Trace]', JSON.stringify({ trace_id: trace.trace_id, step: 'request_received', message, language, client_state: clientState, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }));

    if (!message) {
      return res.status(400).json({ error: 'Field "message" is required' });
    }

    if (assistantType === 'services') {
      const servicesResult = handleServicesDeterministicInput({ message, language, clientState });
      if (servicesResult) {
        pushTraceStep(trace, 'services_result', { route: servicesResult?.debug?.route || null, screen: servicesResult.screen });
        return res.status(200).json(createSuccessPayload({ modelName: model, screen: servicesResult.screen, text: servicesResult.text, responseId: null, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision: servicesResult.decision, actions: servicesResult.actions, toolResults: servicesResult.tool_results, screenState: servicesResult.screen_state, debug: { ...servicesResult.debug, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
      }
    }

    const lastAssistantText = getLastAssistantText(history);
    if (message === '5' && isInitialCategoryMenuText(lastAssistantText)) {
      pushTraceStep(trace, 'entry_promo_shortcut');
      const promoResponse = renderPromoInfoResponse(language);
      const screen = SCREEN_PROMO_INFO;
      return res.status(200).json(createSuccessPayload({ modelName: model, screen, text: promoResponse, responseId: null, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision: { tool: null, parameters: null, response: promoResponse }, actions: [], screenState: { screen }, debug: { route: 'entry_promo_shortcut', assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
    }

    const deterministicResult = await handleDeterministicScreenInput({ message, language, clientState });
    if (deterministicResult) {
      pushTraceStep(trace, 'deterministic_result', { route: deterministicResult?.debug?.route || null, screen: deterministicResult.screen });
      return res.status(200).json(createSuccessPayload({ modelName: model, screen: deterministicResult.screen, text: deterministicResult.text, responseId: null, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision: deterministicResult.decision, actions: deterministicResult.actions, toolResults: deterministicResult.tool_results, screenState: deterministicResult.screen_state, debug: deterministicResult.debug, trace }));
    }

    const genericBrowseQuestion = looksLikeGenericBrowseQuestion(message);
    pushTraceStep(trace, 'generic_browse_check', { generic_browse_question: genericBrowseQuestion });
    if (genericBrowseQuestion) {
      return res.status(200).json(createSuccessPayload({ modelName: model, screen: SCREEN_ENTRY, text: renderCategoryMenuResponse(language), responseId: null, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision: { tool: null, parameters: null, response: renderCategoryMenuResponse(language) }, actions: [], toolResults: [], screenState: { screen: SCREEN_ENTRY }, debug: { route: 'generic_browse_to_entry', generic_browse_question: true, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
    }

    const obviousCollectionIntent = looksLikeObviousCollectionIntent(message);
    pushTraceStep(trace, 'collection_intent_check', { obvious_collection_intent: obviousCollectionIntent });

    const collectionDecisionResult = await requestCollectionDecision({ history, message, clientState });
    pushTraceStep(trace, 'collection_router_first_pass', { raw_output: collectionDecisionResult.raw_output_text, decision: collectionDecisionResult.decision });

    if (collectionDecisionResult.decision?.tool === 'showProductCollection') {
      const decision = collectionDecisionResult.decision;
      const toolResult = await executeToolSelection(decision);
      pushTraceStep(trace, 'collection_router_first_pass_execute', { tool_result_ok: Boolean(toolResult?.action), total_matches: toolResult?.total_matches ?? null, category: toolResult?.category ?? null, source: toolResult?.source || null });
      if (toolResult?.action) {
        const screen = resolveResponseScreen({ decision, toolResult });
        return res.status(200).json(createSuccessPayload({ modelName: model, screen, text: renderProductListResponse(toolResult.visible_products, language), responseId: collectionDecisionResult.response.id, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision, actions: [toolResult.action], toolResults: [toolResult], screenState: { screen, category: toolResult.category, visible_products: toolResult.visible_products }, debug: { route: 'collection_router_first_pass', tool: decision.tool, obvious_collection_intent: obviousCollectionIntent, raw_router_output: collectionDecisionResult.raw_output_text, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
      }
    }

    if (obviousCollectionIntent) {
      const forcedCollectionResult = await forceCollectionDecision({ history, message, clientState });
      pushTraceStep(trace, 'collection_router_forced', { raw_output: forcedCollectionResult.raw_output_text, decision: forcedCollectionResult.decision });
      if (forcedCollectionResult.decision?.tool === 'showProductCollection') {
        const decision = forcedCollectionResult.decision;
        const toolResult = await executeToolSelection(decision);
        pushTraceStep(trace, 'collection_router_forced_execute', { tool_result_ok: Boolean(toolResult?.action), total_matches: toolResult?.total_matches ?? null, category: toolResult?.category ?? null, source: toolResult?.source || null });
        if (toolResult?.action) {
          const screen = resolveResponseScreen({ decision, toolResult });
          return res.status(200).json(createSuccessPayload({ modelName: model, screen, text: renderProductListResponse(toolResult.visible_products, language), responseId: forcedCollectionResult.response.id, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision, actions: [toolResult.action], toolResults: [toolResult], screenState: { screen, category: toolResult.category, visible_products: toolResult.visible_products }, debug: { route: 'collection_router_forced', tool: decision.tool, obvious_collection_intent: true, raw_router_output: collectionDecisionResult.raw_output_text, raw_forced_router_output: forcedCollectionResult.raw_output_text, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
        }
      }
    }

    let { response, decision } = await requestStructuredDecision({ promptText: SYSTEM_PROMPT, history, message, clientState });
    let decisionRoute = 'llm_tool_selection';
    pushTraceStep(trace, 'llm_structured_decision', { decision, output_text: String(response?.output_text || '') });

    if (looksLikeCategoryMenuDecision(decision)) {
      decision.response = renderCategoryMenuResponse(language);
      pushTraceStep(trace, 'llm_category_menu_normalized');
    } else if (looksLikeCategoryChoiceDecision(decision)) {
      const originalResponse = String(decision?.response || '').trim();
      const intro = originalResponse.replace(/daily shoes/gi, '').replace(/running shoes/gi, '').replace(/training shoes/gi, '').replace(/football\s*&\s*court shoes/gi, '').replace(/football and court shoes/gi, '').replace(/sale/gi, '').replace(/reply with a number\.?/gi, '').replace(/\s+/g, ' ').trim();
      decision.response = renderCategoryChoiceResponse(language, intro || null);
      pushTraceStep(trace, 'llm_category_choice_normalized', { intro: intro || null });
    }

    if (!decision?.tool) {
      const recovery = await recoverCollectionDecision({ history, message, clientState });
      pushTraceStep(trace, 'llm_collection_recovery', { raw_output: recovery.raw_output_text, decision: recovery.decision });
      if (recovery.decision?.tool === 'showProductCollection') {
        response = recovery.response; decision = recovery.decision; decisionRoute = 'llm_collection_recovery';
      }
    }

    if (decision?.tool) {
      const toolResult = await executeToolSelection(decision);
      pushTraceStep(trace, 'llm_tool_execute', { route: decisionRoute, tool: decision.tool, tool_result_ok: Boolean(toolResult?.action), total_matches: toolResult?.total_matches ?? null, source: toolResult?.source || null, error: toolResult?.error || null });
      const screen = resolveResponseScreen({ decision, toolResult });
      const screenState = screen === SCREEN_PRODUCT_LIST ? { screen, category: toolResult.category, visible_products: toolResult.visible_products } : screen === SCREEN_PRODUCT_FOCUS ? { screen, category: clientState.category, focus_product_id: toolResult.product_id, focus_product_title: toolResult.product_title, selected_variant: toolResult.selected_variant, variant_options: toolResult.variant_options } : { screen };

      if (screen === SCREEN_PRODUCT_LIST && !decision.response) decision.response = renderProductListResponse(toolResult.visible_products, language);
      if (screen === SCREEN_PRODUCT_FOCUS && !decision.response) decision.response = renderProductFocusResponse(language, toolResult.product_title);

      return res.status(200).json(createSuccessPayload({ modelName: model, screen, text: typeof decision?.response === 'string' ? decision.response : '', responseId: response.id, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision, actions: toolResult.action ? [toolResult.action] : [], toolResults: [toolResult], screenState, debug: { route: decisionRoute, tool: decision.tool, obvious_collection_intent: obviousCollectionIntent, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
    }

    if (obviousCollectionIntent) {
      pushTraceStep(trace, 'collection_router_failed_closed', { first_pass_raw_output: collectionDecisionResult.raw_output_text });
      return res.status(200).json(createSuccessPayload({ modelName: model, screen: SCREEN_ENTRY, text: renderCategoryChoiceResponse(language, language === 'ru' ? 'Не удалось корректно распознать запрос на подбор товаров. Попробуйте выбрать категорию.' : 'Could not reliably route the product-browsing request. Please choose a category.'), responseId: response.id, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision, actions: [], screenState: { screen: SCREEN_ENTRY }, debug: { route: 'collection_router_failed_closed', obvious_collection_intent: true, first_pass_raw_output: collectionDecisionResult.raw_output_text, assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));
    }

    const screen = resolveResponseScreen({ decision, toolResult: null });
    pushTraceStep(trace, 'llm_text_response', { screen, decision });
    return res.status(200).json(createSuccessPayload({ modelName: model, screen, text: typeof decision?.response === 'string' ? decision.response : '', responseId: response.id, historyCount: Math.min(history.length, MAX_HISTORY_MESSAGES), decision, actions: [], screenState: { screen }, debug: { route: 'llm_text_response', assistant_type: assistantType, session_key: agentRequestContext.sessionKey }, trace }));

  } catch (error) {
    console.error('[AI Route Error]', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const OffersTeamAiAssistant = onRequest({
  memory: '512MiB',
  timeoutSeconds: 60,
  maxInstances: 10,
}, app);
