import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.API_KEY ?? 'dev-key';

createApp({ apiKey }).listen(port, () => {
  console.log(`inventory-ledger listening on http://localhost:${port}`);
});
