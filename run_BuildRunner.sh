#!/bin/bash

#---PATHS
srcFolder="src"
topDir="/home/imcase/appblocks"
BuildRunnerDir="${topDir}/BuildRunner"
srcDir="${BuildRunnerDir}/${srcFolder}"
nodeFpath="/home/imcase/.nvm/versions/node/v18.20.5/bin/node"



#---NAVIGATE TO BuildRunner folder
cd ${BuildRunnerDir}

#---START BuildRunner
${nodeFpath} ${srcFolder}/index.js &
