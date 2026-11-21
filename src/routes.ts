/*
 * The app's own route list, from the `routes` command in tapcheck.yml: any program that prints JSON
 * [{method, path, auth?}] on stdout (the framework's route lister piped through a few lines of script). Paths may write
 * their parameters in any common style ({id}, {id?}, <int:pk>, <pk>, :id, (.:format), *splat); each becomes a matcher,
 * so the crawl can say which GET routes it reached and the code suite which writing routes need no sign-in. Routes
 * written as regular expressions aren't understood.
 */
import { execSync } from 'node:child_process';
import type { Config } from './config.ts';

export type Route = { method: string; path: string; auth?: boolean };

const TOKEN = /\/\{[^}]+\?\}|\/:\w+\?|\{[^}]+\}|<path:[^>]+>|<[^>]+>|:\w+|\*\w*|[()]|[^]/g;

/** A route path as a regular expression on a URL path: parameters match one segment, splats the rest, (groups) are optional. */
export function matcher(path: string): RegExp {
    const src = `/${path.replace(/^\/+|\/+$/g, '')}`.replace(TOKEN, (t) => {
        if (t.length > 1 && t.startsWith('/')) return '(?:/[^/]+)?'; // /{id?} and /:id?
        if (t.startsWith('<path:') || t.startsWith('*')) return '.+';
        if (t.length > 1) return '[^/]+'; // {id}, <int:pk>, <pk>, :id
        return t === '(' ? '(?:' : t === ')' ? ')?' : t.replace(/[.+?^$|[\]\\]/, '\\$&');
    });
    return new RegExp(`^${src}/?$`);
}
export const hasParams = (path: string) => /[{<:*(]/.test(path);

/** What the routes command printed, one route per method (GET|HEAD becomes GET), paths with a leading slash. */
export function parse(out: string): Route[] {
    let list;
    try { list = JSON.parse(out); } catch { throw new Error('routes: the command did not print JSON (want [{method, path, auth?}]).'); }
    if (!Array.isArray(list)) throw new Error('routes: the command must print a JSON list of {method, path, auth?}.');
    return list.flatMap((r, i) => {
        if (typeof r?.path !== 'string' || !(typeof r.method === 'string' || Array.isArray(r.method))) throw new Error(`routes: entry ${i} needs a method and a path.`);
        const methods = (Array.isArray(r.method) ? r.method : r.method.split(/[|,\s]+/)).map((m: string) => m.toUpperCase()).filter((m: string) => m && m !== 'HEAD' && m !== 'OPTIONS');
        return methods.map((method: string): Route => ({ method, path: `/${r.path.replace(/^\/+/, '')}`, ...(typeof r.auth === 'boolean' ? { auth: r.auth } : {}) }));
    });
}

let cached: Route[] | undefined;
/** The app's routes: the command runs once per run, from the config file's folder. Empty when no command is configured. */
export function routes(cfg: Config): Route[] {
    if (!cfg.routes) return [];
    return (cached ??= parse(execSync(cfg.routes, { cwd: cfg.root, encoding: 'utf8', shell: '/bin/sh', maxBuffer: 64 * 1024 * 1024 })));
}

/** Of the GET routes, the ones no reached URL path matches. */
export function coverage(list: Route[], reached: string[]) {
    const gets = [...new Set(list.filter((r) => r.method === 'GET').map((r) => r.path))];
    const missed = gets.filter((p) => { const re = matcher(p); return !reached.some((u) => re.test(u)); });
    return { total: gets.length, missed };
}
