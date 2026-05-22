// REQUIRE
const io = require('socket.io-client');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const stream = require('stream');
const cp = require('child_process');
const ini = require('ini');
const dotenv = require('dotenv');
const rimraf = require('rimraf');
const readline = require('readline');

const psTree = require('ps-tree');


// FUNCTIONS
function removeDir(job) {
    const targetDir = jobs[job.id].projectPah;

    if (!fs.pathExistsSync(targetDir)) {
        return;
    }

    try {
        fs.removeSync(targetDir);
    } catch (err) {
        console.error('removeDir error due to', err);
    }
}

function killAllPids(job) {
    // Destroy stdout and stderr of the job's process
    if (job && job.process) {
        job.process.stdout.destroy();
        job.process.stderr.destroy();
    }

    // Kill parentPid
    const parentPid = job.pid;
    if (!parentPid) {
        return;
    }

    try {
        process.kill(parentPid);
    } catch (err) {
        // An error occurs if 'childPid' does not
        // console.error(`(IGNORE) Error killing parentPid: ${parentPid}`);
        // console.log(`Reason: parentPid ${parentPid} already terminated!`);

        // Do NOT return, but continue to check whether there are
        //  any childPids alive which need to be killed.
    }

    if (!job.childPids) {
        return;
    }

    job.childPids.forEach((childPid) => {
        try {
            process.kill(childPid);
        } catch (err) {
            // An error occurs if 'childPid' does not exist or is already terminated
            // console.error(`(IGNORE) Error killing childPid: ${childPid}`);
            // console.log(`Reason: childPid ${childPid} already terminated!`);
        }
    });
}


//  PATHS
// Get 'BuildRunner' Path
let APP_ROOT = path.join(__dirname, '..');
// detect if running in appblocks
if (fs.existsSync(path.join(__dirname, '..', '..', '..', 'package.json'))) {
    const packageJson = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'));
    const packageData = JSON.parse(packageJson);
    if (packageData.name === '@appblocks/root') {
        APP_ROOT = path.join(__dirname, '..', '..', '..');
    }
}
console.log(APP_ROOT);

// Get '.env' Path
const envFilePath = path.join(APP_ROOT, '.env');
dotenv.config({ path: envFilePath });

// Get 'TIDEProjects' Path
const TIDEProjectsDIR = process.env.PROJECTS_DIR || path.join(APP_ROOT, 'TIDEProjects');
// Get 'temp' Path
const tempPath = path.join(TIDEProjectsDIR, 'temp');
// Set constant 'UNDERSCORE_CRON_DOT_CHK'
const UNDERSCORE_CRON_DOT_CHK = '_cron.chk';
// Define the interval in minutes


// INLINE FUNCTIONS
// cron-schedule
const CRON_INTERVAL_MINUTES = 30;
const tempCleanupCron = cron.schedule(`* * * * *`, () => {
    const items = fs.readdirSync(tempPath);
    const currentTime = new Date();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const projectPath = path.join(tempPath, item);
        const projectCronChkFpath = path.join(projectPath, item + UNDERSCORE_CRON_DOT_CHK);

        // Check if the projectPath exists, if not, continue to the next item
        if (!fs.existsSync(projectPath)) {
            continue;
        }

        // Check if the cron check file exists
        if (!fs.existsSync(projectCronChkFpath)) {
            rimraf.sync(projectPath);
            continue;
        }

        // Get file stats and calculate elapsed time
        const stats = fs.statSync(projectCronChkFpath);
        const mtime = new Date(stats.mtime);
        const elapsed = (currentTime.getTime() - mtime.getTime());

        // Remove the folder if it exceeds the CRON interval and is not '.gitkeep'
        if (elapsed > (CRON_INTERVAL_MINUTES * 60 * 1000) && item !== '.gitkeep') {
            rimraf.sync(projectPath);
            console.log(`Removed folder older than ${CRON_INTERVAL_MINUTES}-min: ${projectPath}`);
        }
    }
});

// Create temporary file
const addProjectCronChkToFilesWrites = (job) => {
    const project = job.input.project;

    // Generate a pseudo-unique identifier (puuid) by concatenating two random strings
    let puuid = Math.random().toString(36).substring(2, 15)
        + Math.random().toString(36).substring(2, 15);

    // Check if the `project` object is defined, has a valid `id`,
    // and the `id` is not equal to 'newtemp'
    // If these conditions are met, override the generated `puuid` with `project.id`
    if (project && project.id && project.id !== 'newtemp') {
        puuid = project.id;
    }

    // Build paths and file content
    const projectPath = path.join(tempPath, puuid);
    const projectCronChkFpath = path.join(projectPath, puuid + UNDERSCORE_CRON_DOT_CHK);
    const cronFileContent = `This file is used to keep track of the modified datetime (mtime) of folder '${puuid}'`;

    // Write cron check file and handle errors
    const fileWrites = [
        fs.outputFile(projectCronChkFpath, cronFileContent).catch((err) => {
            console.error(`Error writing ${projectCronChkFpath}: ${err.message}`);
        }),
    ];

    return { fileWrites, puuid };
};

// Get childPids
const getChildPids = async (job) => {
    try {
        // Retrieve the child processes using psTree wrapped in a Promise
        const children = await new Promise((resolve, reject) => {
            psTree(job.pid, (err, children) => {
                if (err) {
                    return reject(err); // Reject the promise on error
                }
                resolve(children); // Resolve the promise with the children
            });
        });

        if (!children) {
            return [];
        }

        // Extract and return the PIDs of the child processes
        const pids = children.map(child => child.PID);

        return pids;
    } catch (err) {
        console.error('Error retrieving child processes due to', err);
        return [];
    }
};


const jobs = {};
const sockets = [];
const workerIntervals = [];
let isShuttingDown = false;

const connectionStates = {};
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let statusBarLineCount = 0;
let statusBarActive = false;
let lastLoggedStatusContent = '';
let spinnerFrame = 0;

function isInteractiveTerminal() {
    return process.stdout.isTTY && process.env.BUILDRUNNER_NO_STATUS_BAR !== '1';
}

function formatEndpointLabel(url) {
    const base = url.replace(/\/workers$/, '');
    try {
        return new URL(base).host;
    } catch (err) {
        return base || url;
    }
}

function getStateSymbol(state) {
    switch (state) {
        case 'connected':
            return '\x1b[32m●\x1b[0m';
        case 'connecting':
        case 'reconnecting':
            return `\x1b[33m${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}\x1b[0m`;
        case 'error':
            return '\x1b[31m✗\x1b[0m';
        case 'disconnected':
            return '\x1b[90m○\x1b[0m';
        default:
            return '?';
    }
}

function buildConnectionStatusLines() {
    const urls = Object.keys(connectionStates);
    if (urls.length === 0) {
        return [];
    }

    const width = process.stdout.columns || 80;
    const divider = `\x1b[2m${'─'.repeat(Math.min(width, 100))}\x1b[0m`;
    const lines = [divider, ` \x1b[1mConnections\x1b[0m`];

    urls.forEach((url) => {
        const { state, detail } = connectionStates[url];
        const label = formatEndpointLabel(url);
        let line = `   ${getStateSymbol(state)} ${label}: ${state}`;
        if (detail && state !== 'connected') {
            line += ` (${detail})`;
        }
        lines.push(line);
    });

    return lines;
}

function clearConnectionStatusBar() {
    if (!statusBarActive || statusBarLineCount === 0) {
        return;
    }
    readline.moveCursor(process.stdout, 0, -statusBarLineCount);
    readline.clearScreenDown(process.stdout);
    statusBarLineCount = 0;
}

function renderConnectionStatusBar(force = false) {
    const lines = buildConnectionStatusLines();
    if (lines.length === 0) {
        return;
    }

    const content = lines.join('\n');
    if (!isInteractiveTerminal()) {
        if (!force && content === lastLoggedStatusContent) {
            return;
        }
        lastLoggedStatusContent = content;
        originalConsoleLog(content);
        return;
    }

    clearConnectionStatusBar();
    lines.forEach((line) => {
        process.stdout.write(`${line}\n`);
    });
    statusBarLineCount = lines.length;
    statusBarActive = true;
}

function setConnectionState(socketURL, state, detail) {
    connectionStates[socketURL] = {
        state,
        detail: detail || null,
        updatedAt: new Date().toISOString(),
    };
    renderConnectionStatusBar(true);
}

function printConnectionStates() {
    renderConnectionStatusBar(true);
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function wrapConsoleOutput(originalFn) {
    return (...args) => {
        if (statusBarActive && isInteractiveTerminal()) {
            clearConnectionStatusBar();
        }
        originalFn(...args);
        if (statusBarActive && isInteractiveTerminal()) {
            renderConnectionStatusBar(true);
        }
    };
}

console.log = wrapConsoleOutput(originalConsoleLog);
console.error = wrapConsoleOutput(originalConsoleError);

function hasPendingConnections() {
    return Object.values(connectionStates).some(({ state }) => (
        state === 'connecting' || state === 'reconnecting'
    ));
}

function trackInterval(fn, ms) {
    const intervalId = setInterval(fn, ms);
    workerIntervals.push(intervalId);
    return intervalId;
}

function shutdown(signal) {
    if (isShuttingDown) {
        process.exit(signal === 'SIGINT' ? 130 : 143);
    }
    isShuttingDown = true;

    const exitCode = signal === 'SIGINT' ? 130 : 143;
    try {
        clearConnectionStatusBar();
        if (isInteractiveTerminal()) {
            process.stdout.write('\n');
        }

        Object.keys(jobs).forEach((jobId) => {
            killAllPids(jobs[jobId]);
        });

        workerIntervals.forEach((intervalId) => clearInterval(intervalId));
        workerIntervals.length = 0;

        sockets.forEach((socket) => {
            try {
                if (socket.io) {
                    socket.io.reconnection(false);
                }
                socket.removeAllListeners();
                socket.disconnect();
                socket.close();
            } catch (err) {
                // ignore cleanup errors during shutdown
            }
        });
        sockets.length = 0;

        if (tempCleanupCron) {
            tempCleanupCron.stop();
        }
    } finally {
        process.exit(exitCode);
    }
}

function setupConnectionStatusBar() {
    if (!isInteractiveTerminal()) {
        return;
    }

    process.stdout.on('resize', () => renderConnectionStatusBar(true));

    trackInterval(() => {
        if (hasPendingConnections()) {
            spinnerFrame += 1;
            renderConnectionStatusBar(true);
        }
    }, 5000);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => clearConnectionStatusBar());

function getTaskLoad() {
    return {
        activeJobs: Object.keys(jobs).length,
    };
}

let servers = [];
try {
    const configPath = path.join(__dirname, '..', 'config.json');
    let configs = [];
    if (fs.existsSync(configPath)) {
        const fileContents = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8');
        configs = JSON.parse(fileContents);
    } else {
        configs.push({
            url: process.env.API_URL,
            key: process.env.WORKER_KEY,
        });
    }
    if (configs) {
        servers = configs;
        for (let i = 0; i < servers.length; i += 1) {
            const server = servers[i];
            const socketURL = `${server.url}/workers`;
            const socket = io(socketURL, {
                path: '/workers',
                pingTimeout: 60000,
                reconnection: true,
                reconnectionAttempts: Infinity,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 10000,
            });
            sockets.push(socket);

            setConnectionState(socketURL, 'connecting');

            socket.on('connect_error', (err) => {
                setConnectionState(socketURL, 'reconnecting', err.message);
            });

            socket.on('disconnect', (reason) => {
                if (isShuttingDown) {
                    return;
                }
                setConnectionState(socketURL, 'reconnecting', reason);
                if (reason === 'io server disconnect') {
                    socket.connect();
                }
            });

            socket.on('reconnect_attempt', () => {
                setConnectionState(socketURL, 'reconnecting');
            });

            socket.on('reconnect_error', (err) => {
                setConnectionState(socketURL, 'reconnecting', err.message);
            });

            socket.on('connect', () => {
                setConnectionState(socketURL, 'connected');
                const jobTypes = [];
                if (process.env.PROJECTS_DIR || process.env.PATH_TMAKE) {
                    jobTypes.push('build:tios');
                }
                if (process.env.ZEPHYR_BASE) {
                    jobTypes.push('build:zephyr');
                }
                console.log(`Worker job types: ${jobTypes.join(', ')}`);
                socket.emit('update', {
                    key: server.key,
                    capabilities: jobTypes,
                    jobs: Object.keys(jobs),
                    load: getTaskLoad(),
                });
                Object.keys(jobs).forEach((jobId) => {
                    const finishedJob = jobs[jobId];
                    if (finishedJob.status === 'completed' || finishedJob.status === 'failed') {
                        socket.emit('job', finishedJob);
                        delete jobs[jobId];
                    }
                });
                socket.emit('load', { key: server.key, ...getTaskLoad() });
            });

            trackInterval(() => {
                if (socket.connected) {
                    socket.emit('load', {
                        key: server.key,
                        ...getTaskLoad(),
                    });
                }
            }, 5000);

            socket.on('update', (job) => {
                if (job.status === 'cancelled') {
                    if (jobs[job.id]) {
                        jobs[job.id].status = 'cancelled';
                    }
                }
            });

            socket.on('job', async (job) => {
                // process the job
                if (!job) {
                    return;
                }

                try {
                    let result;
                    jobs[job.id] = job;
                    socket.emit('load', { key: server.key, ...getTaskLoad() });
                    const outputInterval = setInterval(async () => {
                        // Section: childPids
                        if (jobs[job.id]) {
                            jobs[job.id].childPids = await getChildPids(jobs[job.id]);
                        }
                        // Section: cancelled
                        if (jobs[job.id] && jobs[job.id].status === 'cancelled') {
                            console.log('Build--->>>CANCELLED');
                            clearInterval(outputInterval);

                            killAllPids(jobs[job.id]);
                        }
                        // Section: result, output, progress
                        if (job.status !== 'completed' && job.result && (job.result.output || job.progress)) {
                            socket.emit('job', {
                                ...job,
                                result: {
                                    output: job.result.output,
                                },
                                progress: job.progress,
                            });
                        }
                    }, 1000);


                    // Call the function `addProjectCronChkToFilesWrites`
                    //  and destructure the returned object.
                    // This will extract `fileWrites` (an array of file write tasks)
                    //  and `puuid` (the project unique identifier).
                    const { fileWrites, puuid } = addProjectCronChkToFilesWrites(job);

                    switch (job.type) {
                        case 'build:tios':
                            result = await buildTide(job, puuid, fileWrites);
                            break;
                        case 'build:zephyr':
                            result = await buildZephyr(job, puuid, fileWrites);
                            break;
                        default:

                            break;
                    }
                    clearInterval(outputInterval);
                    job.result = result;
                    job.status = 'completed';
                } catch (ex) {
                    job.status = 'failed';
                    job.result = {
                        output: ex.message.toString(),
                    };
                } finally {
                    if (socket.connected) {
                        socket.emit('job', job);
                        delete jobs[job.id];
                        socket.emit('load', { key: server.key, ...getTaskLoad() });
                    }
                }
            });
        }
        setupConnectionStatusBar();
        trackInterval(printConnectionStates, 30000);
    }
} catch (ex) {
    console.log('unable to read config.json');
}

const BUILDTIDE_SPAWN_TIMEOUT = 60000;
async function buildTide(job, puuid, fileWrites) {
    let PATH_TMAKE = '/home/tibbo/.wine/drive_c/Program Files/Tibbo/TIDE/Bin/tmake.exe';
    const project = job.input.project;
    const files = job.input.files;
    const debug = job.input.debug;
    const customLibraries = job.input.customLibraries;
    let tprPath = '';
    let tpcPath = '';
    let pdbPath = '';
    let projectPath = '';
    const options = '';

    if (!fs.existsSync(TIDEProjectsDIR)) {
        fs.mkdirSync(TIDEProjectsDIR);
    }
    if (!fs.existsSync(tempPath)) {
        fs.mkdirSync(tempPath);
    }

    projectPath = path.join(tempPath, puuid);

    // Add 'projectPath' to dictionary 'jobs' for the current 'job.id'
    jobs[job.id].projectPath = projectPath;

    // check project folder
    if (!fs.existsSync(projectPath)) {
        fs.mkdirSync(projectPath);
    }
    pdbPath = path.join(projectPath, 'tmp', 'database.pdb');

    const tmpTPRPath = files.find(file => file.name === 'project.tpr');
    for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const filePath = path.join(projectPath, file.name);
        const parts = file.name.split('/');
        if (parts[0] === 'libraries' && !customLibraries && process.platform !== 'win32') {
            continue;
        }
        if (file.name.slice(-4) === '.tpr') {
            if (tmpTPRPath !== undefined && tmpTPRPath.name !== file.name) {
                continue;
            }
            tprPath = filePath;
            const tpr = ini.parse(file.contents);
            tpcPath = path.join(path.dirname(tprPath), tpr.project.output);
            tpr.project.debug = debug === 'off' ? 'off' : 'on';
            file.contents = ini.encode(tpr);
        }
        try {
            if (typeof file.contents === 'string') {
                let existingContents = '';
                if (fs.existsSync(filePath)) {
                    existingContents = fs.readFileSync(filePath, 'utf-8');
                    if (existingContents === file.contents) {
                        continue;
                    }
                }
                fileWrites.push(fs.outputFile(filePath, file.contents));
            } else {
                const buf = Buffer.from(file.contents);
                fileWrites.push(fs.outputFile(filePath, buf));
            }
        } catch (ex) {
            console.log(ex);
            return 'error';
        }
    }
    await Promise.all(fileWrites);

    const platformsRoot = path.join(APP_ROOT, 'platforms', 'Platforms');
    if (process.platform === 'win32') {
        const projectPlatform = project.device;
        const platformItems = fs.readdirSync(path.join(platformsRoot));
        for (let i = 0; i < platformItems.length; i += 1) {
            const file = platformItems[i];
            try {
                if (file.indexOf('.tph') >= 0) {
                    fs.copySync(path.join(platformsRoot, file), path.join(projectPath, 'Platforms', file));
                }
                if (file === projectPlatform) {
                    fs.copySync(path.join(platformsRoot, file), path.join(projectPath, 'Platforms', file));
                } else if (file === 'lib') {
                    fs.copySync(path.join(platformsRoot, file), path.join(projectPath, 'Platforms', file));
                } else if (file === 'src') {
                    fs.copySync(path.join(platformsRoot, 'src', '0_00'),
                        path.join(projectPath, 'Platforms/src/0_00'));
                }
            } catch (ex) {
                // return res.status(500).send();
                console.log(ex);
            }
        }
    } else {
        try {
            fs.symlinkSync(platformsRoot, path.join(projectPath, 'Platforms'), 'dir');
            const librariesRoot = path.join(APP_ROOT, 'public', 'projectTemplates', 'libraries');
            if (!customLibraries) {
                fs.symlinkSync(librariesRoot, path.join(projectPath, 'libraries'), 'dir');
            }
        } catch (ex) {
            //
        }
    }

    let ccmd = '';
    let shortPath = decodeURIComponent(tprPath.substring(tprPath.indexOf('TIDEProjects')));
    let platformsPath = `C:\\users\\tibbo\\TIDEProjects\\temp\\${puuid}\\Platforms`;
    const parts = decodeURIComponent(tprPath).split('/');
    parts.pop();
    // const unixPath = parts.join('/');
    if (process.platform === 'win32') {
        PATH_TMAKE = process.env.PATH_TMAKE;
        platformsPath = path.join(APP_ROOT, 'platforms', 'Platforms');
        ccmd = `"${PATH_TMAKE}" "${tprPath}" -p "${platformsPath}" ${options}`;
    } else {
        parts.push('Platforms');
        const tmpPath = `/${parts.join('/')}`;
        if (fs.existsSync(tmpPath)) {
            parts.splice(0, parts.indexOf('TIDEProjects'));
            platformsPath = `C:\\users\\tibbo\\${parts.join('\\')}`;
        }
        while (shortPath.indexOf('/') >= 0) {
            shortPath = shortPath.replace('/', '\\');
        }
        const winProjectPath = `C:\\users\\tibbo\\${shortPath}`;
        const winParts = winProjectPath.split('\\');
        winParts.pop();
        // const windowsPath = winParts.join('\\');
        const options = '';
        // sed -e 's/\\x1b\\[[0-9;]*m//g'
        ccmd = `wine "${PATH_TMAKE}" "${winProjectPath}" -p "${platformsPath}" ${options} | sed -e 's/\\x1b\\[[0-9;]*m//g'; chmod 777 -R "${process.env.PROJECTS_DIR || '/TIDEProjects'}/temp/${puuid}"`;
    }

    if (fs.existsSync(tpcPath)) {
        fs.unlinkSync(tpcPath);
    }
    let pid;
    let compileOutput = '';
    job.result = {
        output: '',
    };
    const buildDir = path.join(projectPath, 'build');
    if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
    }
    const logFilePath = path.join(buildDir, 'build.log');
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
    const dStream = new stream.Writable({
        write: (chunk, encoding, next) => {
            const output = Buffer.concat([chunk]).toString('utf8');
            compileOutput = ''.concat(compileOutput, output);
            job.result.output = compileOutput;
            logStream.write(output);
            next();
        },
    });

    try {
        console.log(ccmd);
        const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: BUILDTIDE_SPAWN_TIMEOUT, shell: true });
        if (!exec.pid) {
            return 'error';
        }
        pid = exec.pid.toString();
        job.pid = pid;
        job.process = exec;
        jobs[job.id].pid = pid;

        const result = await new Promise((resolve, reject) => {
            exec.on('error', (error) => {
                reject();
            });
            exec.on('exit', () => {
                // const compileData = globalThis.compileData.get(pid);
                if (!fs.existsSync(tpcPath) || !fs.existsSync(pdbPath)) {
                    return reject();
                }
                job.result.output = compileOutput;
                if (job.result.output.indexOf('Compiled binary file is too large to fit on currently selected target') >= 0) {
                    return reject('Compiled binary file is too large to fit on currently selected target');
                }
                resolve({
                    files: {
                        binary: fs.readFileSync(tpcPath),
                        symbols: fs.readFileSync(pdbPath),
                    },
                    output: compileOutput,
                });
            });
            exec.stdout.pipe(dStream);
            exec.stderr.pipe(dStream);
        });
        return result;
    } catch (ex) {
        console.log(`job for ${projectPath} failed`);
        console.log(`'ex: ${ex}`);

        return {
            status: 'failed',
            output: compileOutput,
        };
    } finally {
        logStream.end();
        if (jobs && job && job.id) {
            killAllPids(jobs[job.id]);
        }
    }
}


const BUILDZEPHYR_SPAWN_TIMEOUT = 600000;
async function buildZephyr(job, puuid, fileWrites) {
    const project = job.input.project;
    const files = job.input.files;
    let tpcPath = '';
    let pdbPath = '';
    let hexPath = '';
    let projectPath = '';
    let shortPath = '';
    let ccmd = '';

    projectPath = path.join(tempPath, puuid);

    // Add 'projectPath' to dictionary 'jobs' for the current 'job.id'
    jobs[job.id].projectPath = projectPath;

    for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const filePath = path.join(projectPath, file.name);
        const parts = file.name.split('/');
        if (parts[0] === 'libraries' && process.platform !== 'win32') {
            continue;
        }
        try {
            if (typeof file.contents === 'string') {
                let existingContents = '';
                if (fs.existsSync(filePath)) {
                    existingContents = fs.readFileSync(filePath, 'utf-8');
                    if (existingContents === file.contents) {
                        continue;
                    }
                }
                fileWrites.push(fs.outputFile(filePath, file.contents));
            } else {
                const buf = Buffer.from(file.contents);
                fileWrites.push(fs.outputFile(filePath, buf));
            }
        } catch (ex) {
            console.log(ex);
            return 'error';
        }
    }
    await Promise.all(fileWrites);

    tpcPath = path.join(projectPath, 'build', 'zephyr', 'zephyr.bin');
    pdbPath = path.join(projectPath, 'build', 'zephyr', 'zephyr.elf');
    hexPath = path.join(projectPath, 'build', 'zephyr', 'zephyr.hex');
    shortPath = puuid;
    let zephyrProjectPath = process.env.ZEPHYR_BASE;
    let zephyrSDKPath = process.env.ZEPHYR_SDK_INSTALL_DIR;
    // read app/CMakeLists.txt
    const appCMakeListsPath = path.join(projectPath, 'app', 'CMakeLists.txt');
    if (fs.existsSync(appCMakeListsPath)) {
        const appCMakeLists = fs.readFileSync(appCMakeListsPath, 'utf-8');
        const appCMakeListsLines = appCMakeLists.split('\n');
        for (let i = 0; i < appCMakeListsLines.length; i += 1) {
            const line = appCMakeListsLines[i];
            if (line.indexOf('find_package(Zephyr 4.2.99') >= 0) {
                zephyrProjectPath = process.env.ZEPHYR_BASE_42;
                zephyrSDKPath = process.env.ZEPHYR_SDK_INSTALL_DIR_42;
            }
            if (line.indexOf('find_package(Zephyr 4.3.0') >= 0) {
                zephyrProjectPath = process.env.ZEPHYR_BASE_43;
                zephyrSDKPath = process.env.ZEPHYR_SDK_INSTALL_DIR_43;
            }
        }
    }
    if (project.zephyrToolchain === 'nrf') {
        if (process.env.ZEPHYR_BASE_NRF) {
            zephyrProjectPath = process.env.ZEPHYR_BASE_NRF;
            zephyrSDKPath = process.env.ZEPHYR_SDK_INSTALL_DIR_NRF;
        }
    }
    const dirItems = fs.readdirSync(zephyrProjectPath);
    let zephyrPYENVPath = zephyrProjectPath;
    if (!dirItems.includes('zephyr')) {
        zephyrPYENVPath = path.join(zephyrPYENVPath, '..');
    }
    await fs.outputFile(path.join(projectPath, 'files.json'), JSON.stringify(files));
    const cmdArgs = [];
    if (process.platform === 'win32') {
        ccmd = 'cmd.exe';
        cmdArgs.push('/c');
        cmdArgs.push(`"${path.join(zephyrProjectPath, '.venv', 'Scripts', 'activate.bat')} && cd ${process.env.PROJECTS_DIR}/temp && west build -b ${project.zephyrName} ./${shortPath} --build-dir ./${shortPath}/build  -- -DBOARD_ROOT=./"`);
    } else {
        ccmd = 'bash';
        cmdArgs.push('-c');
        let appFolder = './';
        if (fs.existsSync(path.join(projectPath, 'app'))) {
            appFolder = './app';
        }
        cmdArgs.push(`

cd ${projectPath}
${zephyrProjectPath !== '' ? `export ZEPHYR_BASE=${zephyrProjectPath}` : ''}
${zephyrSDKPath !== '' ? `export ZEPHYR_SDK_INSTALL_DIR=${zephyrSDKPath}` : ''}
source ${zephyrPYENVPath}/.venv/bin/activate
export CCACHE_BASEDIR=${projectPath}
export CCACHE_NOHASHDIR=1
west build -b ${project.zephyrName} ${appFolder} --build-dir ./build ${project.zephyrToolchain === 'nrf' ? '--sysbuild' : '--no-sysbuild'}
        `);
    }
    console.log(ccmd, ...cmdArgs);

    if (fs.existsSync(tpcPath)) {
        fs.unlinkSync(tpcPath);
    }
    const chunks = [];

    let pid;
    let compileOutput = '';
    job.result = {
        output: '',
    };
    const buildDir = path.join(projectPath, 'build');
    if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
    }
    const logFilePath = path.join(buildDir, 'build.log');
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
    const dStream = new stream.Writable({
        write: (chunk, encoding, next) => {
            const output = Buffer.concat([chunk]).toString('utf8');
            compileOutput = ''.concat(compileOutput, output);
            compileOutput = ''.concat(compileOutput, output);
            const lines = compileOutput.split('\n');
            const regexp = /\[(\d+)\/(\d+)\].*/g;
            let match;
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                match = regexp.exec(lines[i]);
                if (match) {
                    break;
                }
            }
            if (match) {
                const current = parseInt(match[1], 10);
                const total = parseInt(match[2], 10);
                job.progress = (current / total);
                // if (current === total) {
                //     job.result.output = compileOutput;
                // }
            }
            logStream.write(output);
            next();
        },
    });

    try {
        const exec = cp.spawn(ccmd, cmdArgs,
            {
                env: { ...process.env, NODE_OPTIONS: '' },
                timeout: BUILDZEPHYR_SPAWN_TIMEOUT,
                shell: false,
                windowsVerbatimArguments: true,
            });
        if (!exec.pid) {
            return 'error';
        }
        pid = exec.pid.toString();
        job.pid = pid;
        job.process = exec;
        jobs[job.id].pid = pid;

        const result = await new Promise((resolve, reject) => {
            exec.on('error', (error) => {
                console.log(error);
                reject(error);
            });
            exec.on('exit', () => {
                // const compileData = globalThis.compileData.get(pid);
                job.result.output = compileOutput;
                const exitCode = exec.exitCode;
                if (!fs.existsSync(tpcPath)) {
                    hexPath = path.join(projectPath, 'build', 'app', 'zephyr', 'zephyr.hex');
                    tpcPath = path.join(projectPath, 'build', 'app', 'zephyr', 'zephyr.bin');
                    pdbPath = path.join(projectPath, 'build', 'app', 'zephyr', 'zephyr.elf');
                    if (fs.existsSync(path.join(projectPath, 'build', 'merged.hex'))) {
                        hexPath = path.join(projectPath, 'build', 'merged.hex');
                    }
                }
                if (exitCode !== 0 || !fs.existsSync(tpcPath)) {
                    return reject(exec.exitCode);
                }
                console.log(`job for ${projectPath} completed`);
                let hex;
                if (fs.existsSync(hexPath)) {
                    hex = fs.readFileSync(hexPath);
                }
                resolve({
                    files: {
                        binary: fs.readFileSync(tpcPath),
                        symbols: fs.readFileSync(pdbPath),
                        hex,
                    },
                    output: compileOutput,
                });
            });

            // Preserve existing streams for logs or redirection
            exec.stdout.pipe(dStream);
            exec.stderr.pipe(dStream);
        });

        return result;
    } catch (ex) {
        console.log(`job for ${projectPath} failed`);
        console.log(`'ex: ${ex}`);

        return {
            status: 'failed',
            output: compileOutput,
        };
    } finally {
        logStream.end();
        if (jobs && job && job.id) {
            killAllPids(jobs[job.id]);
        }
    }
}
