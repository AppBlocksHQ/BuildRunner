

## Zephyr 
```
docker pull ghcr.io/zephyrproject-rtos/ci:latest


docker run --rm -v ${zephyrProjectPath}:/workdir -v ${projectPath}:/workdir/${shortPath} ghcr.io/zephyrproject-rtos/ci:latest /bin/bash -c "cd /workdir && west build -b ${project.zephyrName} ./${shortPath} --build-dir ./${shortPath}/build"`;
west init -m https://github.com/zephyrproject-rtos/zephyr --mr v3.2.0 zephyr_3.2

docker 


```