# BuildRunner

Build worker that connects to one or more AppBlocks servers over socket.io and
compiles TiOS (`build:tios`) and Zephyr (`build:zephyr`) projects.

## Self-contained build

`npm run build` bundles the worker and every npm dependency into a single file
and copies the runtime assets alongside it, producing a `dist/` that runs on any
machine with Node.js 18+ — no `node_modules`, no monorepo, no `npm install`:

```
npm run build
node dist/index.js
```

Variants:

| Command | Result |
| --- | --- |
| `npm run build` | full self-contained `dist/` (~21MB) |
| `npm run build:min` | same, with a minified bundle |
| `npm run build:fast` | rebuild the bundle only, leaving assets in place |
| `npm run start:dist` | run the built output |

Add `--with-config` to also copy your live config into `dist/`. It contains
worker keys, so only do that for a private deployment.

### Layout

```
dist/
  index.js                                single-file bundle
  platforms/Platforms/                    .tph/.tp platform sources
  public/projectTemplates/libraries/      stock TIDE libraries
  package.json                            minimal, no dependencies
  config.template.json, .env.template
```

`dist/` is the application root at runtime (the bundle resolves it as
`__dirname`, since the entry point sits at the top of `dist/`), so `.env` and
`config.json` go directly inside `dist/`. Copy the whole directory to deploy;
keep the internal structure intact.

### The `.env` path

The worker loads `.env` from its application root, which moves depending on how
it is run — so the file lives in a different place in each case:

| Run as | Application root | `.env` read from |
| --- | --- | --- |
| `npm start` inside the monorepo | repo root | `<repo>/.env` |
| `npm start` in a standalone checkout | this package | `packages/buildrunner/.env` |
| `node dist/index.js` | `dist/` | `dist/.env` |

`config.json` is separate: it is always read from the package root, i.e.
`packages/buildrunner/config.json` in source and `dist/config.json` in a build. `--with-config` copies from whichever of these locations is live and
prints the path it used, so the build never quietly picks up the wrong `.env`.
If `config.json` is absent the worker falls back to a single server built from
`API_URL` and `WORKER_KEY`.

### Deploying

```
npm run build
rsync -a dist/ worker-host:/opt/buildrunner/
# on the host: create /opt/buildrunner/.env and config.json, then
node /opt/buildrunner/src/index.js
```

A worker advertises `build:tios` when `PROJECTS_DIR` or `PATH_TMAKE` is set, and
`build:zephyr` when `ZEPHYR_BASE` is set, so the same artifact serves both roles
depending on the toolchains installed on the host.

## Zephyr 
```
docker pull ghcr.io/zephyrproject-rtos/ci:latest


docker run --rm -v ${zephyrProjectPath}:/workdir -v ${projectPath}:/workdir/${shortPath} ghcr.io/zephyrproject-rtos/ci:latest /bin/bash -c "cd /workdir && west build -b ${project.zephyrName} ./${shortPath} --build-dir ./${shortPath}/build"`;
west init -m https://github.com/zephyrproject-rtos/zephyr --mr v3.2.0 zephyr_3.2

docker 


```



## Zephyr NRF Connect SDK
```
python3 -m venv /opt/nordic/ncs/v3.2.1/.venv
source /opt/nordic/ncs/v3.2.1/.venv/bin/activate
pip install west

cd v3.2.1
west init -m https://github.com/nrfconnect/sdk-nrf --mr v3.2.1
```

Replace name-allowlist in /opt/nordic/ncs/v3.2.1/nrf/west.yml with the following:

```
name-blocklist: []
```

```
west update
```

# disable sysbuild in zephyr directory
```
west config --global build.sysbuild False
```