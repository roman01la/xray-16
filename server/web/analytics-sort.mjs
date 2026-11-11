// Runs in the authenticated dashboard; sorting never requests another page.
export const performanceSortingScript = String.raw`(() => {
  const table = document.querySelector('#performance');
  if (!table) return;
  const rows = Array.from(table.tBodies[0].rows);
  const headers = Array.from(table.tHead.rows[0].cells);
  const compare = (a, b) => typeof a === 'number' && typeof b === 'number'
    ? a - b : String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'});
  headers.forEach((header, column) => {
    header.querySelector('button').addEventListener('click', () => {
      const ascending = header.getAttribute('aria-sort') !== 'ascending';
      headers.forEach(h => h.removeAttribute('aria-sort'));
      header.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      const sorted = rows.map((row, index) => ({row, index, key: JSON.parse(row.cells[column].dataset.sort)}));
      sorted.sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) {
          const x = a.key[i], y = b.key[i];
          // Missing values stay last in either direction.
          if (x == null || y == null) { if (x !== y) return x == null ? 1 : -1; continue; }
          const order = compare(x, y);
          if (order) return ascending ? order : -order;
        }
        return a.index - b.index;
      });
      table.tBodies[0].append(...sorted.map(item => item.row));
    });
  });
})();`;
