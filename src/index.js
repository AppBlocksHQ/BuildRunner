const io = require('socket.io-client');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const stream = require('stream');
const cp = require('child_process');
const ini = require('ini');
const dotenv = require('dotenv');
const rimraf = require('rimraf');

let workerInterval;


const APP_ROOT = path.join(__dirname, '..');

const envFilePath = path.join(APP_ROOT, '.env');
dotenv.config({ path: envFilePath });

const TIDEProjectsDIR = process.env.PROJECTS_DIR || path.join(APP_ROOT, 'TIDEProjects');

const jobs = {};

cron.schedule('* * * * *', () => {
    const items = fs.readdirSync(TIDEProjectsDIR);
    const currentTime = new Date();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const stats = fs.statSync(path.join(TIDEProjectsDIR, item));
        const mtime = new Date(stats.mtime);
        const elapsed = (currentTime.getTime() - mtime.getTime()) / 1000;
        if (elapsed > 3 * 60 && item !== '.gitkeep') {
            rimraf.sync(path.join(TIDEProjectsDIR, item));
        }
    }
});

let servers = [];
try {
    const fileContents = fs.readFileSync(path.join(APP_ROOT, 'config.json'), 'utf-8');
    const configs = JSON.parse(fileContents);
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
                });
                Object.keys(jobs).forEach((job) => {
                    socket.emit('job', job);
                    delete jobs[job.id];
                });
            });
            
            socket.on('job', async (job) => {
                // process the job
                if (!job) {
                    return;
                }
                try {
                    let result;
                    jobs[job.id] = job;
                    const outputInterval = setInterval(() => {
                        if (socket.connected) {
                            if (job.result && job.result.output) {
                                socket.emit('job', {
                                    ...job,
                                    result: {
                                        output: job.result.output,
                                    },
                                });
                            }
                        }
                    }, 1000);
                    switch (job.type) {
                        case 'build:tios':
                            result = await buildTide(job);
                            break;
                        case 'build:zephyr':
                            result = await buildZephyr(job);
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

async function buildTide(job) {
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
    let puuid = Math.random().toString(36).substring(2, 15)
        + Math.random().toString(36).substring(2, 15);
    if (project && project.id && project.id !== 'newtemp') {
        puuid = project.id;
    }

    if (!fs.existsSync(TIDEProjectsDIR)) {
        fs.mkdirSync(TIDEProjectsDIR);
    }
    if (!fs.existsSync(path.join(TIDEProjectsDIR, 'temp'))) {
        fs.mkdirSync(path.join(TIDEProjectsDIR, 'temp'));
    }
    projectPath = path.join(TIDEProjectsDIR, 'temp', puuid);


    // check project folder

    if (!fs.existsSync(projectPath)) {
        fs.mkdirSync(projectPath);
    }
    pdbPath = path.join(projectPath, 'tmp', 'database.pdb');

    const fileWrites = [];
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
        ccmd = `wine "${PATH_TMAKE}" "${winProjectPath}" -p "${platformsPath}" ${options} | sed -e 's/\\x1b\\[[0-9;]*m//g'; chmod 777 -R "/TIDEProjects/temp/${puuid}"`;
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
            // console.log(output);
            next();
        },
    });

    try {
        console.log(ccmd);
        const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
        exec.on('error', (error) => {
            console.log(error);
        });
        if (!exec.pid) {
            return 'error';
        }
        pid = exec.pid.toString();
        const result = await new Promise((resolve, reject) => {
            exec.on('exit', () => {
                // const compileData = globalThis.compileData.get(pid);
                if (!fs.existsSync(tpcPath)) {
                    return reject();
                }
                resolve({
                    files: {
                        tpc: fs.readFileSync(tpcPath),
                        pdb: fs.readFileSync(path.join(projectPath, 'tmp', 'database.pdb')),
                    },
                    output: compileOutput,
                });
            });
            exec.stdout.pipe(dStream);
        });
        return result;
    } catch (ex) {
        return {
            status: 'failed',
            output: compileOutput,
        };
    }
}

async function buildZephyr(job) {
    const project = job.input.project;
    const files = job.input.files;
    const fileWrites = [];
    let tpcPath = '';
    let pdbPath = '';
    let projectPath = '';
    let shortPath = '';
    let ccmd = '';
    let puuid = Math.random().toString(36).substring(2, 15)
        + Math.random().toString(36).substring(2, 15);
    if (project && project.id && project.id !== 'newtemp') {
        puuid = project.id;
    }

    projectPath = path.join(TIDEProjectsDIR, 'temp', puuid);
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
    let zephyrProjectPath = '~/projects/zephyrcontainer';
    if (project.device.indexOf('nrf') === 0) {
        tpcPath = path.join(projectPath, 'build', 'zephyr', 'zephyr.hex');
        zephyrProjectPath = '~/projects/nrfworkspace';
    }
    await fs.outputFile(path.join(projectPath, 'files.json'), JSON.stringify(files));
    ccmd = `docker run --rm -v ${zephyrProjectPath}:/workdir -v ${projectPath}:/workdir/${shortPath} ghcr.io/zephyrproject-rtos/ci:latest /bin/bash -c "cd /workdir && west build -b ${project.device} ./${shortPath} --build-dir ./${shortPath}/build"`;

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
            job.result.output = compileOutput;
            // console.log(output);
            next();
        },
    });

    try {
        const exec = cp.spawn(ccmd, [], { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60000, shell: true });
        exec.on('error', (error) => {
            console.log(error);
        });
        if (!exec.pid) {
            return 'error';
        }
        pid = exec.pid.toString();
        const result = await new Promise((resolve, reject) => {
            exec.on('exit', () => {
                // const compileData = globalThis.compileData.get(pid);
                const exitCode = exec.exitCode;
                if (exitCode !== 0 && !fs.existsSync(tpcPath)) {
                    return reject();
                }
                resolve({
                    files: {
                        tpc: fs.readFileSync(tpcPath),
                        pdb: fs.readFileSync(pdbPath),
                    },
                    output: compileOutput,
                });
            });
            exec.stdout.pipe(dStream);
        });
        return result;
    } catch (ex) {
        return {
            status: 'failed',
            output: compileOutput,
        };
    }
}
