import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const STOREFRONT_ACCESS_TOKEN = process.env.STOREFRONT_ACCESS_TOKEN;

app.get("/health", (req, res) => res.json({ ok: true }));

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function isColorName(name) {
  const n = norm(name);
  return ["color", "colour", "shade"].includes(n);
}

function isSizeName(name) {
  const n = norm(name);
  // support shirts + pants naming
  return ["size", "waist", "width", "w", "length", "inseam", "l"].includes(n);
}

// pick best "size-like" option; prefer size/waist over length
function pickPrimarySizeKey(keys) {
  const k = keys.map(norm);
  const priority = ["size", "waist", "width", "w", "length", "inseam", "l"];
  for (const p of priority) {
    const idx = k.indexOf(p);
    if (idx !== -1) return keys[idx];
  }
  return keys[0];
}

async function shopifyGraphQL(query, variables) {
  const resp = await fetch(`https://${SHOP_DOMAIN}/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": STOREFRONT_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await resp.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// 1) Search products
app.get("/products/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ products: [] });

    const query = `
      query SearchProducts($q: String!) {
        products(first: 10, query: $q) {
          edges {
            node {
              title
              handle
              featuredImage { url }
              priceRange {
                minVariantPrice { amount currencyCode }
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { q: `title:*${q}*` });

    const products = data.products.edges.map(e => ({
      title: e.node.title,
      handle: e.node.handle,
      image: e.node.featuredImage?.url || null,
      priceFrom: e.node.priceRange.minVariantPrice,
    }));

    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 2) Options endpoint: return available colors + sizes (supports 32/34)
app.get("/products/options", async (req, res) => {
  try {
    const handle = (req.query.handle || "").trim();
    const colorFilter = (req.query.color || "").trim(); // optional

    if (!handle) return res.status(400).json({ error: "handle required" });

    const query = `
      query GetProductOptions($handle: String!) {
        product(handle: $handle) {
          title
          handle
          options { name values }
          variants(first: 250) {
            nodes {
              availableForSale
              selectedOptions { name value }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { handle });
    const p = data.product;
    if (!p) return res.status(404).json({ error: "product not found" });

    const optionNames = p.options.map(o => o.name);

    const colorKeys = optionNames.filter(isColorName);
    const sizeKeys = optionNames.filter(isSizeName);

    const hasColor = colorKeys.length > 0;
    const hasSize = sizeKeys.length > 0;

    const primarySizeKey = hasSize ? pickPrimarySizeKey(sizeKeys) : null;
    const primaryColorKey = hasColor ? colorKeys[0] : null;

    const availableColorsSet = new Set();
    const availableSizesSet = new Set();

    for (const v of p.variants.nodes) {
      if (!v.availableForSale) continue;

      const opts = Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]));

      const vColor = primaryColorKey ? opts[primaryColorKey] : null;
      const vSize = primarySizeKey ? opts[primarySizeKey] : null;

      if (vColor) availableColorsSet.add(vColor);

      if (vSize) {
        if (!colorFilter) {
          availableSizesSet.add(vSize);
        } else if (!vColor) {
          // if no color option exists, still add size
          availableSizesSet.add(vSize);
        } else if (norm(vColor) === norm(colorFilter)) {
          availableSizesSet.add(vSize);
        }
      }
    }

    const availableColors = Array.from(availableColorsSet).sort((a, b) => a.localeCompare(b));

    // numeric sorting first (30, 32, 34), then text (S, M, L)
    const availableSizes = Array.from(availableSizesSet).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      const aNum = !Number.isNaN(na), bNum = !Number.isNaN(nb);
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return String(a).localeCompare(String(b));
    });

    res.json({
      product: { title: p.title, handle: p.handle },
      hasColor,
      hasSize,
      colorOptionName: primaryColorKey,
      sizeOptionName: primarySizeKey,
      availableColors,
      availableSizes,
      filteredByColor: colorFilter || null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 3) Variant endpoint: price + availability for selected size/color (supports Waist/Size)
app.get("/products/variant", async (req, res) => {
  try {
    const handle = (req.query.handle || "").trim();
    const size = (req.query.size || "").trim();
    const color = (req.query.color || "").trim();

    if (!handle) return res.status(400).json({ error: "handle required" });

    const query = `
      query GetProduct($handle: String!) {
        product(handle: $handle) {
          title
          handle
          options { name values }
          variants(first: 250) {
            nodes {
              id
              title
              availableForSale
              selectedOptions { name value }
              price { amount currencyCode }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { handle });
    const p = data.product;
    if (!p) return res.status(404).json({ error: "product not found" });

    // detect option keys on this product
    const optionNames = p.options.map(o => o.name);
    const colorKeys = optionNames.filter(isColorName);
    const sizeKeys = optionNames.filter(isSizeName);

    const colorKey = colorKeys.length ? colorKeys[0] : null;
    const sizeKey = sizeKeys.length ? pickPrimarySizeKey(sizeKeys) : null;

    // find matching variant
    let match = null;
    for (const v of p.variants.nodes) {
      const opts = Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]));

      const vColor = colorKey ? (opts[colorKey] || "") : "";
      const vSize = sizeKey ? (opts[sizeKey] || "") : "";

      const okSize = size ? norm(vSize) === norm(size) : true;
      const okColor = color ? norm(vColor) === norm(color) : true;

      if (okSize && okColor) {
        match = v;
        break;
      }
    }

    res.json({
      product: { title: p.title, handle: p.handle },
      requested: { size, color },
      variant: match
        ? {
            id: match.id,
            title: match.title,
            availableForSale: match.availableForSale,
            price: match.price,
            selectedOptions: match.selectedOptions,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 4) Best Seller endpoint (collection handle: best-sellers)
app.get("/products/best-seller", async (req, res) => {
  try {
    const query = `
      query BestSeller($handle: String!) {
        collection(handle: $handle) {
          title
          products(first: 1) {
            edges {
              node {
                title
                handle
                featuredImage { url }
                priceRange {
                  minVariantPrice { amount currencyCode }
                }
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { handle: "best-sellers" });

    const edge = data.collection?.products?.edges?.[0];
    if (!edge) return res.json({ product: null });

    const p = edge.node;
    res.json({
      product: {
        title: p.title,
        handle: p.handle,
        image: p.featuredImage?.url || null,
        priceFrom: p.priceRange.minVariantPrice,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log(`Server running on port ${process.env.PORT || 8080}`);
});
