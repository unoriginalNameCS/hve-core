'use strict';

const path = require('node:path');
const express = require('express');
const { createApiApp } = require('./api');

const app = createApiApp();
const clientDirectory = path.join(__dirname, '..', 'dist');
app.use(express.static(clientDirectory));
app.get(/.*/, (_request, response) => response.sendFile(path.join(clientDirectory, 'index.html')));

const port = Number(process.env.PORT || 4175);
app.listen(port, '127.0.0.1', () => {
  console.log(`Codebase transformation demo listening at http://127.0.0.1:${port}`);
});
