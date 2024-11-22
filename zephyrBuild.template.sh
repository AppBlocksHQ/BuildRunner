#!/bin/bash

source $ZEPHYR_BASE/../.venv/bin/activate

cd ./TIDEProjects/temp/$1

west build -b $2 ./ --build-dir ./build
