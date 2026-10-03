#!/usr/bin/env python3
"""将已授权的专用飞书测试账号迁移到 CI；凭据只通过 stdin/Secrets 传递。"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SECRET_NAME = "FEISHU_E2E_LARK_AUTH_B64"


def identities(config, expected_app):
    apps = config.get("apps", [])
    if len(apps) != 1 or apps[0].get("appId") != expected_app:
        raise ValueError("授权目录必须只包含指定的测试 App")
    users = apps[0].get("users", [])
    if len(users) != 1:
        raise ValueError("授权目录必须只包含一个测试用户")
    user = users[0].get("userOpenId", "")
    if not re.fullmatch(r"cli_[a-zA-Z0-9]+", expected_app) or not re.fullmatch(r"ou_[a-zA-Z0-9]+", user):
        raise ValueError("测试 App 或用户标识无效")
    return user


def file_names(app, user):
    return [".lark-cli/config.json", ".local/share/lark-cli/master.key",
            f".local/share/lark-cli/appsecret_{app}.enc",
            f".local/share/lark-cli/{app}_{user}.enc"]


def pack(home, app):
    config = json.loads((home / ".lark-cli/config.json").read_text())
    user = identities(config, app)
    files = {name: base64.b64encode((home / name).read_bytes()).decode()
             for name in file_names(app, user)}
    encoded = base64.b64encode(json.dumps({"version": 1, "appId": app, "files": files}).encode()).decode()
    if len(encoded) >= 48 * 1024:
        raise ValueError("授权包超过 GitHub Secret 大小限制")
    return encoded


def restore(encoded, home, app):
    bundle = json.loads(base64.b64decode(encoded, validate=True))
    if bundle.get("version") != 1 or bundle.get("appId") != app:
        raise ValueError("授权包版本或测试 App 不匹配")
    files = bundle["files"]
    config = json.loads(base64.b64decode(files[".lark-cli/config.json"], validate=True))
    user = identities(config, app)
    expected = file_names(app, user)
    if set(files) != set(expected):
        raise ValueError("授权包包含预期之外的文件")
    decoded = {name: base64.b64decode(files[name], validate=True) for name in expected}
    if len(decoded[expected[1]]) != 32 or any(not value for value in decoded.values()):
        raise ValueError("授权包缺少有效密钥或凭据")
    # 先完整校验再写入；目标必须是本次运行的新目录。
    home.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, value in decoded.items():
        target = home / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(value)
        target.chmod(0o600)
    return user, home / expected[-1], hashlib.sha256(encoded.encode()).hexdigest()[:24]


def auth_env(home):
    return dict(os.environ, HOME=str(home), USERPROFILE=str(home),
                LARKSUITE_CLI_CONFIG_DIR=str(home / ".lark-cli"),
                XDG_DATA_HOME=str(home / ".local/share"),
                LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER="1")


def verify(home, app):
    user = identities(json.loads((home / ".lark-cli/config.json").read_text()), app)
    result = subprocess.run(["npx", "lark-cli", "auth", "status", "--verify"],
                            env=auth_env(home), text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError("飞书授权核验失败；请检查专用测试账号的登录状态")
    status = json.loads(result.stdout)
    identity = status.get("identities", {}).get("user", {})
    if status.get("appId") != app or identity.get("openId") != user or not identity.get("verified"):
        raise ValueError("飞书用户授权不可用或身份不匹配")
    print(f"已核验测试 App {app}、用户 {user} 的登录态")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["publish", "restore", "verify"])
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--repo")
    args = parser.parse_args()
    if args.action == "publish":
        if not args.repo:
            parser.error("publish 需要 --repo")
        verify(args.home, args.app_id)
        encoded = pack(args.home, args.app_id)
        subprocess.run(["gh", "secret", "set", SECRET_NAME, "--repo", args.repo],
                       input=encoded, text=True, check=True)
        print(f"已更新 {SECRET_NAME}；未输出凭据内容")
    elif args.action == "restore":
        encoded = os.environ.get(SECRET_NAME, "")
        if not encoded:
            raise ValueError(f"缺少 {SECRET_NAME}")
        user, token_file, generation = restore(encoded, args.home, args.app_id)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"token-file={token_file}\ncache-generation={generation}\n")
        print(f"已恢复测试 App {args.app_id}、用户 {user} 的隔离登录目录")
    else:
        verify(args.home, args.app_id)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        # 不把可能带有凭据的异常参数输出到 CI 日志。
        raise SystemExit("飞书测试授权操作失败；检查专用账号、Secret 配置和目录权限。")
