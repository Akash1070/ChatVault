import initSqlJs from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A shim that mimics better-sqlite3's API using sql.js.
 * Provides the same synchronous-looking .prepare().run(), .get(), .all()
 * but saves to disk after every write operation.
 */
export class SqlJsDatabase {
  public db: any;
  public name: string;
  private memoryMode: boolean;

  constructor(private dbPath: string) {
    this.name = dbPath;
    this.memoryMode = dbPath === ':memory:';
    // The inner 'db' is injected by the async factory
  }

  public pragma(str: string): any {
    // WAL mode and cache PRAGMAs aren't really applicable to sql.js,
    // but we support the method so it doesn't crash.
    try {
      this.db.exec(`PRAGMA ${str}`);
    } catch (e) {
      // Ignore pragma errors
    }
  }

  public prepare(sql: string) {
    return new SqlJsStatement(this, sql);
  }

  public exec(sql: string): void {
    this.db.exec(sql);
    this.save();
  }

  public transaction(fn: Function): Function {
    return (...args: any[]) => {
      this.db.exec('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        this.save();
        return result;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
  }

  public close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }

  public save(): void {
    if (this.memoryMode || !this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }
}

class SqlJsStatement {
  constructor(private shim: SqlJsDatabase, private sql: string) {}

  private formatParams(args: any[]) {
    if (args.length === 0) return [];
    if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0]) && args[0] !== null) {
      const params = args[0];
      const formatted: any = {};
      for (const key of Object.keys(params)) {
        formatted[`@${key}`] = params[key];
        formatted[`:${key}`] = params[key];
        formatted[`$${key}`] = params[key];
      }
      return formatted;
    }
    return args; // array of positional parameters
  }

  public run(...args: any[]) {
    const stmt = this.shim.db.prepare(this.sql);
    try {
      stmt.run(this.formatParams(args));
    } finally {
      stmt.free();
    }
    if (this.sql.trim().toUpperCase().match(/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/)) {
      this.shim.save();
    }
    return { changes: 1, lastInsertRowid: 0 };
  }

  public get(...args: any[]) {
    const stmt = this.shim.db.prepare(this.sql);
    try {
      stmt.bind(this.formatParams(args));
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  public all(...args: any[]) {
    const stmt = this.shim.db.prepare(this.sql);
    try {
      stmt.bind(this.formatParams(args));
      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      stmt.free();
    }
  }
}

/**
 * Async factory to initialize sql.js and create the Database.
 */
export async function createSqlJsDatabase(dbPath: string): Promise<SqlJsDatabase> {
  // Pass locateFile so sql.js can find the .wasm file if it's bundled weirdly
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, file)
  });
  const shim = new SqlJsDatabase(dbPath);

  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    shim.db = new SQL.Database(filebuffer);
  } else {
    shim.db = new SQL.Database();
  }
  return shim;
}
