#!/usr/bin/env python3
"""构建本机架构的 AI Hub.app；输出、备份和本机签名偏好只写入忽略目录。"""
import argparse
import json
import os
import re
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


def signing_identity(root, requested=None):
    """复用本机已选身份；首次仅自动选择唯一的开发身份，不写入证书或私钥。"""
    result = subprocess.run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], capture_output=True, text=True, check=True)
    identities = {key: name for key, name in re.findall(r'\d+\) ([A-F0-9]{40}) "([^"]+)"', result.stdout)}
    preference = root / '.local/macos-signing.json'
    saved = None
    if preference.is_file():
        saved = json.loads(preference.read_text()).get('identity')
    chosen = requested or saved
    if chosen == '-':
        return '-', None
    if chosen:
        matches = [key for key, name in identities.items() if key == chosen or name == chosen]
        if len(matches) != 1:
            raise ValueError('已选签名身份不可用，请通过 --sign-identity 选择可用身份；为保护已有权限，不自动切换为临时签名。')
        return matches[0], preference
    developers = [key for key, name in identities.items() if name.startswith('Apple Development:')]
    if len(developers) == 1:
        return developers[0], preference
    if len(developers) > 1:
        raise ValueError('有多个开发签名身份，请用 --sign-identity 指定本机身份。')
    return '-', None


def install_bundle(bundle, destination, backup):
    """保留应用外层目录，避免系统授权随重命名后的旧应用移到备份路径。"""
    if not destination.exists():
        shutil.copytree(bundle, destination, symlinks=True)
        return
    shutil.copytree(destination, backup, symlinks=True)
    content = destination / 'Contents'
    try:
        shutil.rmtree(content)
        shutil.copytree(bundle / 'Contents', content, symlinks=True)
    except Exception:
        if content.exists():
            shutil.rmtree(content)
        shutil.copytree(backup / 'Contents', content, symlinks=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-ui-build', action='store_true', help='复用已构建的 ui/dist')
    parser.add_argument('--sign-identity', default=os.environ.get('AI_HUB_SIGN_IDENTITY'), help='本机签名身份；首次自动选择唯一 Apple Development，- 显式选择临时签名')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('macOS App 需要在安装 Xcode 命令行工具的 Mac 上构建；其他系统仍可使用网页版')
    if not args.skip_ui_build:
        if not (ROOT / 'ui/node_modules').exists():
            run('npm', '--prefix', str(ROOT / 'ui'), 'ci')
        run('npm', '--prefix', str(ROOT / 'ui'), 'run', 'build')
    if not (ROOT / 'ui/dist/index.html').is_file():
        parser.error('ui/dist 不存在，请先构建网页版')
    try:
        identity, signing_preference = signing_identity(ROOT, args.sign_identity)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    if identity == '-':
        print('使用临时签名：重新构建会改变应用身份，辅助功能权限可能需要重新授权。')
    else:
        print('使用本机稳定开发签名，更新保持应用身份；首次更换签名需核对系统授权。')
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
        shutil.copy2(ROOT / 'scripts/tracker_outbox.py', resources / 'tracker_outbox.py')
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
        run('codesign', '--force', '--sign', identity, str(picker))
        run('xcrun', 'swift', str(ROOT / 'desktop/macos/icon.swift'), str(resources))
        run('codesign', '--force', '--sign', identity, str(bundle))
        run('codesign', '--verify', '--deep', '--strict', str(bundle))
        destination = output / 'AI Hub.app'
        if destination.exists():
            existing = destination / 'Contents/Info.plist'
            if not existing.exists() or plistlib.loads(existing.read_bytes()).get('CFBundleIdentifier') != 'com.aihub.desktop':
                parser.error('目标目录已有其他应用，停止覆盖')
            backup = build / ('AI Hub-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.app')
        else:
            backup = build / ('AI Hub-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.app')
        install_bundle(bundle, destination, backup)
        run('codesign', '--verify', '--deep', '--strict', str(destination))
        if signing_preference:
            signing_preference.parent.mkdir(exist_ok=True)
            signing_preference.write_text(json.dumps({'identity': identity}, indent=2) + '\n')
            signing_preference.chmod(0o600)
    archive = output / f'AI-Hub-macOS-{architecture}.zip'
    if archive.exists():
        archive.rename(build / (datetime.now().strftime('%Y%m%d-%H%M%S-%f-') + archive.name))
    run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(destination), str(archive))
    print(f'可双击应用：{destination}\n可携带压缩包：{archive}')


if __name__ == '__main__':
    main()
