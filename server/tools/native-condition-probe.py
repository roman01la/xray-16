#!/usr/bin/env python3
"""Run the real-host condition probe with private, disposable state.

Build native xr_3da/xrGame and `cargo build --release --bin native_condition_probe`
first. The game source supplies fsgame.ltx and asset directories; its writable
_appdata_ and outbox are never reused. No HTTP server or browser is started.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-source', required=True, type=Path)
    parser.add_argument('--catalog', required=True, type=Path)
    parser.add_argument('--collision', required=True, type=Path)
    parser.add_argument('--native-binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path, help='new directory for evidence')
    parser.add_argument('--timeout', type=float, default=220)
    parser.add_argument('--hit-backpressure', action='store_true', help='withhold hit acknowledgements until the native 512-hit gate closes; use --timeout 900')
    parser.add_argument('--reserve-ammo', action='store_true', help='validate persisted reserve ammunition against native owner inventory')
    parser.add_argument('--weapon-action', action='store_true', help='exercise native reload socket and durable commit handshake')
    parser.add_argument('--native-reload', action='store_true', help='exercise original native reload action using disposable ammunition')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    probe_binary = repo / 'server/target/release/native_condition_probe'
    source, catalog, native = (p.resolve(strict=True) for p in
                               (args.game_source, args.catalog, args.native_binary))
    if not probe_binary.is_file() or args.timeout <= 0:
        parser.error('build the probe first and use a positive timeout')
    trial = args.output.absolute()
    trial.mkdir(mode=0o700)  # Deliberately refuse an existing run/database.
    game = trial / 'game'
    game.mkdir()
    (game / '_appdata_').mkdir()
    (trial / 'outbox').mkdir(mode=0o700)
    shutil.copy(source / 'fsgame.ltx', game / 'fsgame.ltx')
    user = source / '_appdata_/user.ltx'
    if user.is_file():
        shutil.copy(user, game / '_appdata_/user.ltx')
    for name in ('patches', 'resources', 'mp', 'gamedata', 'levels', 'localization', 'Localization'):
        asset = source / name
        if asset.exists():
            destination = game / name
            if not destination.exists():  # Case-insensitive macOS volumes.
                destination.symlink_to(asset.resolve(), target_is_directory=True)
    probe = host = None
    success = False
    cleanup = {}
    host_exit_before_cleanup = None
    with tempfile.TemporaryDirectory(prefix='zone-cond-', dir='/tmp') as sockets:
        socket = sockets + '/host'
        env = os.environ | {
            'ZONE_ALIFE_INTEREST_SOCKET': socket,
            'ZONE_ALIFE_OUTBOX_DIR': str(trial / 'outbox'),
            'ZONE_ALIFE_LEVEL': 'zaton', 'ZONE_ALIFE_ANCHOR': '-121 3.2626 306',
        }
        with (trial / 'probe.log').open('w') as p_log, (trial / 'host.log').open('w') as h_log:
            try:
                probe = subprocess.Popen([str(probe_binary), socket, str(trial / 'probe.sqlite'), str(catalog), str(args.collision.resolve(strict=True))],
                                         stdout=p_log, stderr=subprocess.STDOUT,
                                         env=os.environ | {"ZONE_PROBE_HIT_BACKPRESSURE": "1" if args.hit_backpressure else "0",
                                                            "ZONE_PROBE_RESERVE_AMMO": "1" if args.reserve_ammo else "0",
                                                            "ZONE_PROBE_WEAPON_ACTION": "1" if args.weapon_action else "0",
                                                            "ZONE_PROBE_NATIVE_RELOAD": "1" if args.native_reload else "0"})
                host = subprocess.Popen([str(native), '-cop', '-r3', '-nosplash', '-nointro', '-nogameintro',
                    '-i', '-silent_error_mode', '-nosound', '-noprefetch', '-zone-alife-headless',
                    '-zone-alife-host', '-zone-alife-probe', *(['-zone-native-weapon-actions'] if args.weapon_action else []), *(['-zone-native-reload-probe'] if args.native_reload else []), '-start', 'server(all/single/alife/new)', 'client(localhost)'],
                    cwd=game, env=env, stdout=h_log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + args.timeout
                while probe.poll() is None and host.poll() is None and time.monotonic() < deadline:
                    time.sleep(.25)
                host_exit_before_cleanup = host.poll()
                success = probe.poll() == 0 and host_exit_before_cleanup is None
            finally:
                for name, process in (("probe", probe), ("host", host)):
                    if process is not None and process.poll() is None:
                        cleanup[name] = {"terminateSent": True, "killSent": False}
                        process.terminate()
                        try:
                            process.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            cleanup[name]["killSent"] = True
                            process.kill()
                            process.wait()
            host_text = (trial / 'host.log').read_text(errors='replace')
            dropped_hits = host_text.count('Zone A-Life hit queue is full')
            # An otherwise successful condition probe must not hide producer loss.
            success = success and dropped_hits == 0
            result = {'passed': success, 'nativeHitOverflowReports': dropped_hits,
                      'hitBackpressureRequested': args.hit_backpressure,
                      'trial': str(trial), 'probeExit': probe.returncode,
                      'hostExit': host.returncode, 'hostExitBeforeCleanup': host_exit_before_cleanup,
                      'cleanup': cleanup, 'gracefulHostShutdownVerified': False}
            (trial / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            print((trial / 'probe.log').read_text())
            print(json.dumps(result))
            return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(main())
