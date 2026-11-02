#!/usr/bin/env python3
"""构建本机架构的 AI Hub.app；仅写入 Hub 的忽略目录 .build 与 dist。"""
import argparse
from datetime import datetime
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(*arguments):
    subprocess.run(arguments, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-ui-build', action='store_true', help='复用已构建的 ui/dist')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('macOS App 需要在安装 Xcode 命令行工具的 Mac 上构建；其他系统仍可使用网页版')
    if not args.skip_ui_build:
        if not (ROOT / 'ui/node_modules').exists():
            run('npm', '--prefix', str(ROOT / 'ui'), 'ci')
        run('npm', '--prefix', str(ROOT / 'ui'), 'run', 'build')
    if not (ROOT / 'ui/dist/index.html').is_file():
        parser.error('ui/dist 不存在，请先构建网页版')
    build = ROOT / '.build'; build.mkdir(exist_ok=True)
    output = ROOT / 'dist'; output.mkdir(exist_ok=True)
    architecture = platform.machine()
    with tempfile.TemporaryDirectory(prefix='macos-', dir=build) as temp:
        bundle = Path(temp) / 'AI Hub.app'
        content = bundle / 'Contents'
        executable = content / 'MacOS'; executable.mkdir(parents=True)
        resources = content / 'Resources'; resources.mkdir()
        shutil.copytree(ROOT / 'ui/dist', resources / 'web')
        shutil.copy2(ROOT / 'scripts/preview_hub.py', resources / 'preview_hub.py')
        shutil.copy2(ROOT / 'scripts/usage_hub.py', resources / 'usage_hub.py')
        shutil.copy2(ROOT / 'scripts/project_hub.py', resources / 'project_hub.py')
        shutil.copy2(ROOT / 'scripts/rules_hub.py', resources / 'rules_hub.py')
        shutil.copy2(ROOT / 'scripts/market_hub.py', resources / 'market_hub.py')
        shutil.copy2(ROOT / 'scripts/market_server.py', resources / 'market_server.py')
        shutil.copy2(ROOT / 'scripts/market_collect.py', resources / 'market_collect.py')
        shutil.copy2(ROOT / 'scripts/tracker_hub.py', resources / 'tracker_hub.py')
        shutil.copy2(ROOT / 'scripts/tracker_config.py', resources / 'tracker_config.py')
        shutil.copy2(ROOT / 'scripts/cursor_rules.applescript', resources / 'cursor_rules.applescript')
        info = dict(CFBundleName='AI Hub', CFBundleDisplayName='AI Hub', CFBundleExecutable='AIHub',
                    CFBundleIdentifier='com.aihub.desktop', CFBundlePackageType='APPL', CFBundleShortVersionString='0.7.0',
                    CFBundleVersion='12', LSMinimumSystemVersion='13.0', NSHighResolutionCapable=True,
                    NSAppleEventsUsageDescription='读取和同步你在 Cursor 中的个人全局规则。',
                    NSPrincipalClass='NSApplication', CFBundleIconFile='AIHub',
                    NSAppTransportSecurity={'NSAllowsLocalNetworking': True})
        (content / 'Info.plist').write_bytes(plistlib.dumps(info))
        run('xcrun', 'swiftc', '-swift-version', '6', '-default-isolation', 'MainActor', '-enable-upcoming-feature', 'NonisolatedNonsendingByDefault',
            '-O', '-target', f'{architecture}-apple-macos13.0', '-framework', 'Cocoa', '-framework', 'WebKit',
            str(ROOT / 'desktop/macos/main.swift'), '-o', str(executable / 'AIHub'))
        picker = resources / 'ProjectPicker.app'
        picker_content = picker / 'Contents'; picker_executable = picker_content / 'MacOS'
        picker_executable.mkdir(parents=True)
        (picker_content / 'Info.plist').write_bytes(plistlib.dumps(dict(
            CFBundleName='AI Hub 文件夹选择器', CFBundleDisplayName='AI Hub 文件夹选择器',
            CFBundleIdentifier='com.aihub.desktop.picker', CFBundleExecutable='AIHubProjectPicker',
            CFBundlePackageType='APPL', CFBundleVersion='1', LSUIElement=True, LSMinimumSystemVersion='13.0')))
        run('xcrun', 'swiftc', '-swift-version', '6', '-default-isolation', 'MainActor', '-O',
            '-target', f'{architecture}-apple-macos13.0', '-framework', 'Cocoa',
            str(ROOT / 'desktop/macos/project_picker.swift'), '-o', str(picker_executable / 'AIHubProjectPicker'))
        run('codesign', '--force', '--sign', '-', str(picker))
        run('xcrun', 'swift', str(ROOT / 'desktop/macos/icon.swift'), str(resources))
        run('codesign', '--force', '--sign', '-', str(bundle))
        run('codesign', '--verify', '--deep', '--strict', str(bundle))
        destination = output / 'AI Hub.app'
        if destination.exists():
            existing = destination / 'Contents/Info.plist'
            if not existing.exists() or plistlib.loads(existing.read_bytes()).get('CFBundleIdentifier') != 'com.aihub.desktop':
                parser.error('目标目录已有其他应用，停止覆盖')
            backup = build / ('AI Hub-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.app')
            destination.rename(backup)
        shutil.move(str(bundle), destination)
    archive = output / f'AI-Hub-macOS-{architecture}.zip'
    if archive.exists():
        archive.rename(build / (datetime.now().strftime('%Y%m%d-%H%M%S-%f-') + archive.name))
    run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(destination), str(archive))
    print(f'可双击应用：{destination}\n可携带压缩包：{archive}')


if __name__ == '__main__':
    main()
