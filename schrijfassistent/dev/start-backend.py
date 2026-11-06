"""Initialize local fixtures, then replace this process with the API server."""
import os
import runpy

runpy.run_path("/opt/dev/seed-container.py", run_name="__main__")
os.execvp("gunicorn", ["gunicorn", "-c", "gunicorn.conf.py", "main:app"])
