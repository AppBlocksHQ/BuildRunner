

## Zephyr 
```
docker pull ghcr.io/zephyrproject-rtos/ci:latest


docker run --rm -v ${zephyrProjectPath}:/workdir -v ${projectPath}:/workdir/${shortPath} ghcr.io/zephyrproject-rtos/ci:latest /bin/bash -c "cd /workdir && west build -b ${project.zephyrName} ./${shortPath} --build-dir ./${shortPath}/build"`;
west init -m https://github.com/zephyrproject-rtos/zephyr --mr v3.2.0 zephyr_3.2

docker 


```



## Zephyr NRF Connect SDK
```
python3 -m venv ~/ncs/.venv
source ~/ncs/.venv/bin/activate
pip3 install west

mkdir v3.2.1
cd v3.2.1
west init -m https://github.com/nrfconnect/sdk-nrf --mr v3.2.1
```

Replace name-allowlist in nrf/west.yml with the following:

```
name-blocklist: []
```

```
west update
```