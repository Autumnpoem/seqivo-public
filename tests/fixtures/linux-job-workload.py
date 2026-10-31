import os
import pathlib
import sys
import time
import threading

mode, workspace = sys.argv[1:]
root = pathlib.Path(workspace)
with (root / 'launches.txt').open('a') as log:
    log.write('launch\n')
if mode == 'double-fork':
    if os.fork():
        os._exit(0)
    os.setsid()
    if os.fork():
        os._exit(0)
if mode == 'thread-fork':
    def threaded_child():
        if os.fork() == 0:
            (root / 'workload.pid').write_text(str(os.getpid()))
            while True:
                time.sleep(1)
        while True:
            time.sleep(1)
    thread = threading.Thread(target=threaded_child)
    thread.start()
    thread.join()
if mode == 'zombie-child':
    if os.fork() == 0:
        os._exit(0)
    # Deliberately leave an exited child for this live parent to reap.
    time.sleep(0.1)
(root / 'workload.pid').write_text(str(os.getpid()))
print('workload-ready', flush=True)
while True:
    time.sleep(1)
