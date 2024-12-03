#!/bin/bash

echo -e "[BuildRunner] retrieve 'node.\*index.js' pid" 
pid=$(ps axf | grep "node.*index.js" | grep -v "grep" | awk '{print $1}')

echo -e "[BuildRunner] kill ${pid}"
sudo -S kill -9 ${pid}
