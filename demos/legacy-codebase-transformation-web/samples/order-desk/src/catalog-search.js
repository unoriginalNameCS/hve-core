'use strict';

function searchCatalog(products, searchText, filters = {}) {
  const matches = [];
  let normalizedText = '';
  if (typeof searchText === 'string') {
    normalizedText = searchText.toLowerCase().trim();
  }

  for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
    const product = products[productIndex];
    let includeProduct = true;

    if (product && typeof product === 'object') {
      if (filters.category) {
        if (product.category) {
          if (product.category.toLowerCase() !== filters.category.toLowerCase()) {
            includeProduct = false;
          }
        } else {
          includeProduct = false;
        }
      }

      if (filters.inStock === true) {
        if (typeof product.stock === 'number') {
          if (product.stock <= 0) includeProduct = false;
        } else {
          includeProduct = false;
        }
      }

      if (filters.maximumPrice !== undefined) {
        if (typeof product.price === 'number') {
          if (product.price > filters.maximumPrice) {
            includeProduct = false;
          } else {
            if (product.price <= filters.maximumPrice) includeProduct = includeProduct && true;
          }
        } else {
          includeProduct = false;
        }
      }

      if (normalizedText.length > 0) {
        let textMatches = false;
        if (typeof product.name === 'string') {
          if (product.name.toLowerCase().includes(normalizedText)) textMatches = true;
        }
        if (!textMatches && typeof product.description === 'string') {
          if (product.description.toLowerCase().includes(normalizedText)) textMatches = true;
        }
        if (!textMatches && Array.isArray(product.tags)) {
          for (let tagIndex = 0; tagIndex < product.tags.length; tagIndex += 1) {
            if (typeof product.tags[tagIndex] === 'string') {
              if (product.tags[tagIndex].toLowerCase().includes(normalizedText)) textMatches = true;
            }
          }
        }
        if (!textMatches) includeProduct = false;
      }

      if (includeProduct) matches.push(product);
    }
  }

  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let index = 0; index < matches.length - 1; index += 1) {
      const currentName = typeof matches[index].name === 'string' ? matches[index].name.toLowerCase() : '';
      const nextName = typeof matches[index + 1].name === 'string' ? matches[index + 1].name.toLowerCase() : '';
      if (currentName > nextName) {
        const currentProduct = matches[index];
        matches[index] = matches[index + 1];
        matches[index + 1] = currentProduct;
        swapped = true;
      }
    }
  }

  return matches;
}

module.exports = { searchCatalog };
