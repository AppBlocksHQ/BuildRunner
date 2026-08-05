/**
 * Builds a self-contained BuildRunner distribution into ./dist
 *
 * Layout produced (dist/ itself is APP_ROOT; the bundle is told so via the
 * BUILDRUNNER_BUNDLED define, since it no longer sits one level down in src/):
 *
 *   dist/
 *     index.js                                <- single-file bundle, no node_modules
 *     platforms/Platforms/...                 <- .tph/.tp platform sources
 *     public/projectTemplates/libraries/...   <- stock TIDE libraries
 *     package.json                            <- minimal, dependency-free
 *     config.template.json, .env.template, README.md
 *
 * The result runs on any machine with Node.js installed:
 *   node dist/index.js
 *
 * Flags:
 *   --minify        minify the bundle
 *   --sourcemap     emit dist/index.js.map
 *   --no-assets     bundle only (skip the 30MB asset copy) for fast rebuilds
 *   --with-config   also copy the local .env / config.json into dist/
 *                   (contains worker keys -- never do this for a shared artifact)
 */

// eslint-disable-next-line import/no-extraneous-dependencies
const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');

const PKG_ROOT = __dirname;
const REPO_ROOT = path.join(PKG_ROOT, '..', '..');
const DIST = path.join(PKG_ROOT, 'dist');

/**
 * Mirrors the runtime's APP_ROOT resolution in src/index.js: the appblocks
 * monorepo root when built from inside it, otherwise this package. APP_ROOT is
 * where the worker loads `.env` from, so the build has to agree with it.
 */
function resolveAppRoot() {
    const rootPkg = path.join(REPO_ROOT, 'package.json');
    if (fs.existsSync(rootPkg)) {
        try {
            if (JSON.parse(fs.readFileSync(rootPkg, 'utf-8')).name === '@appblocks/root') {
                return REPO_ROOT;
            }
        } catch (ex) {
            // Unparseable root manifest: fall through to the standalone layout.
        }
    }
    return PKG_ROOT;
}

const APP_ROOT = resolveAppRoot();

const argv = process.argv.slice(2);
const hasFlag = flag => argv.includes(flag);

const minify = hasFlag('--minify');
const sourcemap = hasFlag('--sourcemap');
const copyAssets = !hasFlag('--no-assets');
const withConfig = hasFlag('--with-config');

const pkg = require('./package.json');

// Skip VCS bookkeeping, macOS cruft, and the libraries submodule's test
// fixtures (which contain symlinks pointing back at their own root).
const IGNORED_NAMES = new Set([
    '.git', '.gitattributes', '.gitignore', '.gitmodules', '.DS_Store', '.tests',
]);
const assetFilter = src => !IGNORED_NAMES.has(path.basename(src));

// Optional native accelerators for `ws`; they are require()'d inside a
// try/catch, so leaving them unresolved is safe and keeps the bundle portable.
const EXTERNAL = ['bufferutil', 'utf-8-validate'];

/**
 * Resolves the first existing candidate path, so the build works both from
 * the appblocks monorepo and from a standalone BuildRunner checkout.
 */
function resolveFirst(candidates) {
    return candidates.find(candidate => fs.existsSync(candidate));
}

function formatSize(bytes) {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function dirSize(target) {
    let total = 0;
    const stack = [target];
    while (stack.length > 0) {
        const current = stack.pop();
        const stats = fs.lstatSync(current);
        if (stats.isDirectory()) {
            fs.readdirSync(current).forEach(entry => stack.push(path.join(current, entry)));
        } else {
            total += stats.size;
        }
    }
    return total;
}

async function bundle() {
    const outfile = path.join(DIST, 'index.js');

    await esbuild.build({
        entryPoints: [path.join(PKG_ROOT, 'src', 'index.js')],
        outfile,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: EXTERNAL,
        minify,
        sourcemap,
        logLevel: 'info',
        define: {
            'process.env.BUILDRUNNER_VERSION': `"${pkg.version}"`,
            // Tells the runtime that __dirname is already APP_ROOT (dist/),
            // instead of the src/ subdirectory it lives in when run from source.
            'process.env.BUILDRUNNER_BUNDLED': '"1"',
        },
    });

    console.log(`  bundle  dist/index.js (${formatSize(fs.statSync(outfile).size)})`);
}

function writePackageJson() {
    // Dependency-free manifest: everything is already inside the bundle.
    const manifest = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description || 'AppBlocks build worker',
        private: true,
        main: 'index.js',
        scripts: {
            start: 'node ./index.js',
        },
    };
    fs.outputJsonSync(path.join(DIST, 'package.json'), manifest, { spaces: 4 });
    console.log('  asset   dist/package.json');
}

function copyTree(label, from, to) {
    if (!from) {
        console.warn(`  SKIP    ${label} not found -- builds needing it will fail`);
        return;
    }
    // Symlinks are copied as symlinks, not followed: the libraries tree contains
    // relative self-references that stay valid once the structure is preserved.
    fs.copySync(from, path.join(DIST, to), { filter: assetFilter });
    console.log(`  asset   dist/${to} (${formatSize(dirSize(path.join(DIST, to)))})`);
}

function copyFiles() {
    // Platform sources: prefer this package's own submodule, fall back to the monorepo's.
    if (withConfig) {
        // `.env` is read from APP_ROOT (the monorepo root when built in-tree),
        // while `config.json` sits next to the entry point. Both land in dist/,
        // which becomes APP_ROOT for the built worker.
        const sources = {
            '.env': path.join(APP_ROOT, '.env'),
            'config.json': path.join(PKG_ROOT, 'config.json'),
        };
        Object.keys(sources).forEach((name) => {
            const from = sources[name];
            if (!fs.existsSync(from)) {
                console.warn(`  SKIP    ${name} not found at ${from}`);
                return;
            }
            fs.copySync(from, path.join(DIST, name));
            console.log(`  secret  dist/${name} (from ${path.relative(PKG_ROOT, from)}, contains worker credentials)`);
        });
    }
}

async function main() {
    if (copyAssets) {
        fs.removeSync(DIST);
    } else {
        fs.removeSync(path.join(DIST, 'index.js'));
        fs.removeSync(path.join(DIST, 'index.js.map'));
    }
    fs.ensureDirSync(DIST);

    await bundle();

    if (copyAssets) {
        writePackageJson();
        copyFiles();
    } else {
        console.log('  asset   skipped (--no-assets)');
    }

    console.log(`\nSelf-contained build ready: ${DIST} (${formatSize(dirSize(DIST))})`);
    console.log('Run with: node dist/index.js');
    if (copyAssets && !withConfig) {
        console.log('Before running, put .env and config.json (see the .template files) in dist/');
    }
}

main().catch((ex) => {
    console.error(ex);
    process.exit(1);
});
