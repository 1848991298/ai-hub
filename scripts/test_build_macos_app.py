#!/usr/bin/env python3
"""隔离验证签名身份复用、应用路径保留和安装失败恢复，不访问真实钥匙串。"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import build_macos_app as build

class BuildIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.output=subprocess.CompletedProcess([],0,'  1) '+ 'A'*40+' "Apple Development: Sample (TEAM)"\n','')
    def test_single_development_identity_selected_and_saved_identity_reused(self):
        with patch.object(build.subprocess,'run',return_value=self.output):
            identity,location=build.signing_identity(self.root)
            self.assertEqual(identity,'A'*40)
            self.assertEqual(location,self.root/'.local/macos-signing.json')
            location.parent.mkdir();location.write_text(json.dumps({'identity':'A'*40}))
            self.assertEqual(build.signing_identity(self.root)[0],identity)
            location.write_text(json.dumps({'identity':'B'*40}))
            with self.assertRaises(ValueError):build.signing_identity(self.root)
            self.assertEqual(build.signing_identity(self.root,'-'),('-',None))
    def test_no_development_identity_uses_explicitly_reported_local_signing(self):
        with patch.object(build.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'0 valid identities found','')):
            self.assertEqual(build.signing_identity(self.root),('-',None))
    def test_update_keeps_bundle_directory_and_copies_old_version_to_backup(self):
        current=self.root/'AI Hub.app';stage=self.root/'new.app';backup=self.root/'backup.app'
        for folder,value in [(current,'old'),(stage,'new')]:
            (folder/'Contents').mkdir(parents=True);(folder/'Contents/app').write_text(value)
        inode=current.stat().st_ino
        build.install_bundle(stage,current,backup)
        self.assertEqual(current.stat().st_ino,inode)
        self.assertEqual((current/'Contents/app').read_text(),'new')
        self.assertEqual((backup/'Contents/app').read_text(),'old')
    def test_failed_install_restores_old_contents_without_moving_app(self):
        current=self.root/'AI Hub.app';stage=self.root/'new.app';backup=self.root/'backup.app'
        for folder,value in [(current,'old'),(stage,'new')]:
            (folder/'Contents').mkdir(parents=True);(folder/'Contents/app').write_text(value)
        copytree=shutil.copytree
        def failing(source,target,*args,**kwargs):
            if Path(source)==stage/'Contents':raise OSError('sample copy failure')
            return copytree(source,target,*args,**kwargs)
        inode=current.stat().st_ino
        with patch.object(build.shutil,'copytree',side_effect=failing):
            with self.assertRaises(OSError):build.install_bundle(stage,current,backup)
        self.assertEqual(current.stat().st_ino,inode)
        self.assertEqual((current/'Contents/app').read_text(),'old')

if __name__=='__main__':unittest.main()
