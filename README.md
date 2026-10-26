<div align="center">
  <img src="logo/logo.png" alt="Xeno.JS Logo" width="140" />

  <h1>Xeno.JS Sqlite</h1>
  <p><strong>A Typescript application framework architecture for Node.js, designed for lower technical debt, and faster infrastructure migrations.</strong></p>
  <p>Build long-lived applications with explicit dependency injection, DDD, CQRS, and transport-independent business logic.</p>

  <p>
    <a href="https://www.npmjs.com/package/@xeno-js/sqlite"><img src="https://img.shields.io/npm/v/@xeno-js/sqlite?style=flat-square" alt="NPM Version" /></a>
    <a href="https://github.com/xeno-js/sqlite"><img src="https://img.shields.io/badge/Powered%20by-Xeno-blueviolet?style=flat-square" alt="Powered by Xeno" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT" /></a>
    <a href="https://buymeacoffee.com/xenojs">
      <img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-FFdd00?style=flat-square&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
    </a>
  </p>
</div>

---

# @xeno-js/sqlite

Official SQLite and libSQL integration plugin for **Xeno.JS**, built on top of Drizzle ORM.

## Features

- **Polymorphic Database Support:** Native integration with SQLite and libSQL (including Turso and local file databases) using Drizzle ORM.
- **Transactional Outbox Pattern:** First-party support for reliable asynchronous event dispatching using an automated background worker with atomic updates (`UPDATE ... RETURNING` and WAL mode optimizations).
- **Unit of Work Management:** Integrated transaction state handling to ensure atomic operations across database changes and outbox event publishing.
- **Seamless DI Integration:** Designed specifically for the Xeno.JS composition root and service container architecture.

## Installation

```bash
npm install @xeno-js/sqlite @libsql/client drizzle-orm
```

## Usage

Register the plugin inside your Xeno.JS application bootstrap:

```typescript
import { XenoAppBuilder } from '@xeno-js/core';
import { withSqlite } from '@xeno-js/sqlite';

const app = new XenoAppBuilder<MyRegistry>()
  .addDb(withSqlite((opts, config) => {
    opts.url = config.getOrThrow('DATABASE_URL'); // e.g. "file:local.db"
    opts.authToken = config.get('DB_AUTH_TOKEN');
    opts.outbox = {
      enable: true,
      worker: true, // Run the background outbox worker
      name: ['Order', 'Product'], // Aggregate names for outbox tables
    };
  }));
```

## License

MIT [License](LICENSE).
