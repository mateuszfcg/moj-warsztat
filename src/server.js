const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`${config.appName} działa na ${config.baseUrl}`);
  console.log(`KSeF: ${config.ksef.mode}`);
});
