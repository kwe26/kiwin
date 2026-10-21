# Kiwi(N)
> It is a Web Hosting Panel just like cPanel or Plesk or aaPanel. This Panel focuses in easy migration and is like an Operating-System

# Architecture
- images/sys.img
- images/user.img

## images/sys.img
> Stores the Virtual System Image to be used

## images/user.img
> Stores User Encrypted Image


# Kiwin System (isolation runtime)
`kiwin.ts` runs `./system` as an isolated OS using bubblewrap, and is itself run by systemd on the host.

- **Isolation**: `./system` is the root, with its own PID/IPC/UTS namespaces. The network is shared with the host, so a port bound inside (e.g. nginx `:80`) is directly reachable on the host at `0.0.0.0:*`, and outbound network works.
- **Shared files**: host `/www` → `/mount/www`. The kiwin project directory itself is masked inside, so the isolation can't modify the code the host runs as root.
- **isol (systemd-like)**: `src/agent/agent.ts` runs inside the isolation on the isolation's own bun (`/usr/bin/bun`) and supervises units from `/etc/isol/*.json`. The host daemon talks to it over a unix socket.
- **SSH layer**: the host listens on `:2222` (`kiwin.json`). Logins are checked against `~/.ssh/authorized_keys` inside the isolation (public keys only), and sessions land inside the live isolation.

## Install
    sudo ./deploy/install.sh       # systemd unit, /usr/local/bin/kiwin, seeds system/etc/isol from defaults/
    sudo kiwin status

## Unit file (`/etc/isol/<name>.json` inside the isolation)
| key | meaning |
| --- | --- |
| `exec` | main process: argv array, or a string run by `/bin/sh -c` |
| `pre` / `post` | commands run before start / after stop |
| `reload` / `reloadSignal` | reload: the command runs first (e.g. a config check), then the signal is sent |
| `enabled` | autostart (default true) |
| `restart` | `always` \| `on-failure` (default) \| `no`; `restartSec`, `restartLimit` (per 60s) |
| `stopSignal` / `stopTimeout` | graceful stop, then SIGKILL to the whole process group |
| `user` / `group` / `cwd` / `env` / `after` | as in systemd |

Note: stdio of units is a pipe captured into `/var/log/isol/<unit>.log`. Don't point logs at `/dev/stdout`.

## CLI
    kiwin status | list | ps | daemon-reload
    kiwin start|stop|restart|reload|enable|disable <unit>
    kiwin logs nginx -f
    kiwin shell [user]          kiwin exec -- nginx -t
    kiwin kill <pid> [SIG]      kiwin isolation-restart
