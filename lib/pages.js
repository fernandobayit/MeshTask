'use strict';
const { ensure } = require('./errors');
// Iterator keeps SQLite from materializing a complete output/history collection.
function page(rows, { key, decode = (row) => row, maxBytes = 262144, maxRows = 50 }) {
  const items = []; let bytes = 2, next = null;
  for (const row of rows) {
    const item = decode(row), size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length && (items.length >= maxRows || bytes + size > maxBytes)) { next = items[items.length - 1][key]; break; }
    items.push(item); bytes += size;
  }
  return { items, next };
}
function boundedList(rows, decode) {
  const items = []; let bytes = 2;
  for (const row of rows) {
    const item = decode(row); bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    ensure(bytes <= 900000, 'RESPONSE_TOO_LARGE', 'Listagem excede orçamento do alpha; consulta específica por ID necessária.');
    items.push(item);
  }
  return items;
}
module.exports = { page, boundedList };
