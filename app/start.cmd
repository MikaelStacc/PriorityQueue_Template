@echo off
rem Starts the queue app and opens it in the browser. Close this window to stop it.
title Priority Queue
node "%~dp0server.js" --open
