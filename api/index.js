const { handleRequest } = require('../server-core');

module.exports = async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
  }
};