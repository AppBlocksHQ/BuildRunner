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
        console.error(`(IGNORE) Error killing parentPid: ${parentPid}`);
        console.log(`Reason: parentPid ${parentPid} already terminated!`);

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
            console.error(`(IGNORE) Error killing childPid: ${childPid}`);
            console.log(`Reason: childPid ${childPid} already terminated!`);
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
const CRON_INTERVAL_MINUTES = 60000;
cron.schedule(`*/${CRON_INTERVAL_MINUTES} * * * *`, () => {
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
        const elapsed = (currentTime.getTime() - mtime.getTime()) / 1000;

        // Remove the folder if it exceeds the CRON interval and is not '.gitkeep'
        if (elapsed > (CRON_INTERVAL_MINUTES * 60) && item !== '.gitkeep') {
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
            });

            socket.on('connect_error', (err) => {
                console.log(`connect_error due to ${err.message}`);
            });

            socket.on('disconnect', (reason, details) => {
                console.log(`disconnected due to ${reason}, ${JSON.stringify(details)}`);
            });

            socket.on('connect', () => {
                console.log('Connected to Server');
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
                });
                Object.keys(jobs).forEach((job) => {
                    socket.emit('job', job);
                    delete jobs[job.id];
                });
            });

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
                        if (job.result && (job.result.output || job.progress)) {
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
                    }
                }
            });
        }
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
            if (debug === 'off') {
                tpr.project.debug = 'off';
                file.contents = ini.encode(tpr);
            }
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
    const dStream = new stream.Writable({
        write: (chunk, encoding, next) => {
            const output = Buffer.concat([chunk]).toString('utf8');
            compileOutput = ''.concat(compileOutput, output);
            job.result.output = compileOutput;
            console.log(output);
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
                if (!fs.existsSync(tpcPath)) {
                    return reject();
                }
                job.result.output = compileOutput;
                resolve({
                    files: {
                        binary: fs.readFileSync(tpcPath),
                        symbols: fs.readFileSync(path.join(projectPath, 'tmp', 'database.pdb')),
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
        if (jobs && job && job.id) {
            killAllPids(jobs[job.id]);
        }
    }
}


const BUILDZEPHYR_SPAWN_TIMEOUT = 60000;
async function buildZephyr(job, puuid, fileWrites) {
    console.log('Building Zephyr');
    const project = job.input.project;
    const files = job.input.files;
    let tpcPath = '';
    let pdbPath = '';
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
    shortPath = puuid;
    let zephyrProjectPath = process.env.ZEPHYR_BASE;
    if (project.zephyrToolchain === 'nrf') {
        if (process.env.ZEPHYR_BASE_NRF) {
            zephyrProjectPath = process.env.ZEPHYR_BASE_NRF;
        }
    }
    const dirItems = fs.readdirSync(zephyrProjectPath);
    if (!dirItems.includes('zephyr')) {
        zephyrProjectPath = path.join(zephyrProjectPath, '..');
    }
    await fs.outputFile(path.join(projectPath, 'files.json'), JSON.stringify(files));
    ccmd = `cd ${process.env.PROJECTS_DIR}/temp && west build -b ${project.zephyrName} ./${shortPath} --build-dir ./${shortPath}/build`;;
    if (fs.existsSync(path.join(__dirname, '..', 'zephyrBuild.sh'))) {
        ccmd = `./zephyrBuild.sh ${shortPath} ${project.zephyrName}`;
    }
    // Windows
    if (fs.existsSync(path.join(__dirname, '..', 'zephyrBuild.bat'))) {
        ccmd = `cmd /c "zephyrBuild.bat ${shortPath} ${project.zephyrName}"`;
    }
    console.log(ccmd);

    if (fs.existsSync(tpcPath)) {
        fs.unlinkSync(tpcPath);
    }
    const chunks = [];

    let pid;
    let compileOutput = '';
    job.result = {
        output: '',
    };
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
            next();
        },
    });

    try {
        const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: BUILDZEPHYR_SPAWN_TIMEOUT, shell: true });
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
                if (exitCode !== 0 && !fs.existsSync(tpcPath)) {
                    return reject(exec.exitCode);
                }
                console.log(`job for ${projectPath} completed`);
                let hex;
                if (fs.existsSync(path.join(projectPath, 'build', 'zephyr', 'zephyr.hex'))) {
                    hex = fs.readFileSync(path.join(projectPath, 'build', 'zephyr', 'zephyr.hex'));
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
        if (jobs && job && job.id) {
            killAllPids(jobs[job.id]);
        }
    }
}
