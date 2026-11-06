// Our sport keys, shared by every collector. draw = the main market is 1X2
// (regular time). For draw sports only 3-way / double-chance prices are
// comparable; a book's 2-way price (e.g. hockey incl. overtime) is dropped.
module.exports = {
  football: { name: 'Football', draw: true },
  tennis: { name: 'Tennis', draw: false },
  hockey: { name: 'Hockey', draw: true },
  basketball: { name: 'Basketball', draw: false },
  tabletennis: { name: 'Table tennis', draw: false },
  esports: { name: 'Esports', draw: false },
  volleyball: { name: 'Volleyball', draw: false },
  handball: { name: 'Handball', draw: true },
};
