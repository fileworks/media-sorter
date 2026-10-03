# Advanced headless and CLI setup

The desktop installer is the supported simple entry point. Headless mode builds
the backend from source; it supplies an API, not the desktop interface. Docker
Engine/Compose and a writable destination are prerequisites on the server.
This guide does not assert that your NAS has been configured or tested.

## Locally built Docker backend (POSIX shell)

Clone the public source and run from its root. Choose existing source/destination
directories, and make the destination writable to the container's UID 1000.
The example mounts source read-only and publishes the API on loopback only:

```sh
git clone https://github.com/fileworks/media-sorter.git
cd media-sorter
export MEDIA_SOURCE=/absolute/path/to/source
export MEDIA_DEST=/absolute/path/to/destination
# Needs Python 3 on the host solely to generate a fresh launch capability.
export MEDIASORT_API_CAPABILITY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker build -t mediasort-backend:local backend
docker volume create mediasort-config
docker run -d --name mediasort-backend --restart unless-stopped   -p 127.0.0.1:8000:8000 -e MEDIASORT_API_CAPABILITY   -v mediasort-config:/config   -v "$MEDIA_SOURCE:/media/source:ro" -v "$MEDIA_DEST:/media/dest"   mediasort-backend:local
docker logs mediasort-backend
```

Keep the capability in the launching session or a protected secret store; do not
commit, paste into reports or print it. Generate a new value for a new launch.
Use an SSH tunnel for remote access rather than exposing port 8000 publicly.
Alternatively, after setting the same three environment variables, run
`docker compose up -d --build`. The sample binds loopback and requires an explicit
capability; both Docker health probes authenticate without printing it. Check
`docker compose ps` and `docker compose logs backend` before using the CLI.
Its base Docker image installs core dependencies, not all optional local AI extras.

## CLI client

Follow [development setup](development.md#setup) to create the locked backend
environment on the client. From the repo root, keep `MEDIASORT_API_CAPABILITY`
set to the same capability and `MEDIASORT_API_URL` set to the reachable API.
Inside the Docker backend, source/destination paths are `/media/source` and
`/media/dest`; host paths are not interchangeable with those paths.

```sh
backend/.venv/bin/python -m cli.main --help
backend/.venv/bin/python -m cli.main config set --source /media/source --target /media/dest
backend/.venv/bin/python -m cli.main config validate
backend/.venv/bin/python -m cli.main scan
backend/.venv/bin/python -m cli.main preview
```

In Windows PowerShell substitute `backend/.venv/Scripts/python.exe`; environment
variables use `$env:MEDIASORT_API_URL` and `$env:MEDIASORT_API_CAPABILITY`.
Only start execution after reviewing the plan: `sort start --watch`, followed by
`sort report TASK_ID`. Retain independent backups; do not remove named volumes
as a troubleshooting step. See [state/recovery](state-and-recovery.md).
