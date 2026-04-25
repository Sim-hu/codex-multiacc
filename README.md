# codex-accounts

複数の Codex アカウントを切り替えて、ネイティブの `codex` CLI を起動するための薄いラッパーです。

コマンド名は短く `cx` です。`codex` 本体は同梱せず、PATH 上にある既存のネイティブ `codex` をそのまま使います。アカウントごとに `CODEX_HOME` を分離するので、認証情報を書き換えずに切り替えられます。

## インストール

```powershell
npm install -g .
```

確認:

```powershell
cx version
codex --version
```

## 使い方

### アカウントごとにログインする

```powershell
cx login main
cx login sub
```

`cx login <name>` は、内部的に次のようにネイティブ `codex login` を起動します。

```text
CODEX_HOME=~/.codex-accounts/accounts/<name> codex login
```

API key ログインを使う場合も、`--` 以降を `codex login` に渡せます。

```powershell
$env:OPENAI_API_KEY | cx login main -- --with-api-key
```

### 既存の `~/.codex` ログインを取り込む

すでに通常の `codex login` でログイン済みの場合は、現在の `CODEX_HOME` から `auth.json` と設定をコピーできます。

```powershell
cx import main
```

複数アカウントを取り込む例:

```powershell
codex login
cx import main

codex logout
codex login
cx import sub
```

### アクティブアカウントを切り替える

```powershell
cx list
cx use main
cx current
cx next
```

`next` は登録済みアカウントを名前順にローテーションします。`switch` も同じ動作です。

### TUI で切り替える

```powershell
cx pick
```

矢印キーまたは `j` / `k` で選び、Enter でアクティブアカウントを変更します。

`cx` だけで起動すると、アカウント切り替え用の軽い対話シェルが開きます。ここではスラッシュコマンドでアカウントを切り替えられます。

```text
cx:no-account> /login main
cx:main> /login sub
cx:main> /account sub
cx:sub> このリポジトリをレビューして
```

シェル内で使える主なコマンド:

```text
/account                  show active account
/account <name>           switch active account
/accounts                 list accounts
/limits                   show usage reset windows
/gui                      open live reset dashboard
/statusline               print one-line usage status
/next                     rotate active account
/pick                     open account picker
/limit [name]             mark account as rate-limited locally
/unlimit [name]           clear rate-limit marker
/login <name> [args...]   run codex login for an account
/status [name]            run codex login status
/codex [args...]          start native codex TUI/command with the active account
/help                     show help
/exit                     quit
```

通常の文章を入力すると、その時点のアクティブアカウントで `codex exec <入力文>` を実行します。native Codex TUI 自体の中に外部コマンドとして `/account` を差し込む仕組みはないため、アカウント切り替えは `cx` のシェル側で扱います。

### リセット時刻を確認する

登録済みの全アカウントについて、Codex 公式の `account/rateLimits/read` から取れる `resetsAt` を表示できます。

```powershell
cx limits
cx gui
cx statusline
```

`cx gui` はターミナル内で更新される一覧です。`q` で終了します。
`cx statusline` は shell prompt、tmux/zellij/kitty などのステータス表示に載せやすい 1 行形式です。デフォルトでは 60 秒キャッシュします。即時更新したい場合は `--fresh` を付けます。

```text
Codex Accounts - usage reset dashboard

Account            Status       Used   Window   Reset                 Remaining
-----------------  -----------  -----  -------  --------------------  ---------
* main             limited      80%    5h       04/26, 02:30          4h 12m
  sub              ready          0%    7d       05/01, 12:00          6d 11h
```

`cx --auto-next ...` でレートリミットを検出したアカウントは、従来どおりローカルに記録されます。`cx gui` はそれとは別に、公式の `resetsAt` を毎回読み直して表示します。

```powershell
cx limit main
cx unlimit main
cx statusline --fresh
cx statusline --active
```

`cx` shell の中でも同じ情報を見られます。

```text
/limits
/gui
/statusline
/limit main
/unlimit main
```

kitty を使っている場合は [integrations/kitty.conf](integrations/kitty.conf) を include すると、オーバーレイでアカウント選択と Codex 起動ができます。

```conf
include /absolute/path/to/codex-multiacc/integrations/kitty.conf
```

PowerShell のプロンプトに載せるなら、例えば `$PROFILE` に次を置けます。

```powershell
function prompt {
  $cx = cx statusline 2>$null
  "[$cx] PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
```

ネイティブ Codex TUI 自体のステータス行へ外部から任意表示を差し込む公開 API は見当たらないため、TUI 内に常駐表示したい場合は Codex CLI の fork 側で TUI コンポーネントに組み込む必要があります。現状の `cx` では、TUI の外側で使える `cx gui` と `cx statusline` を提供します。

### 指定アカウントで Codex を起動する

アクティブアカウントで起動:

```powershell
cx exec "このリポジトリをレビューして"
```

アカウントを明示:

```powershell
cx -a sub exec "テストを実行して問題を直して"
```

対話 UI を起動:

```powershell
cx tui
```

`cx` の account shell の中では `/codex` で native Codex TUI を起動できます。

### レートリミット時に次のアカウントへ切り替える

非対話実行では、レートリミットらしいエラーを検出したときに次のアカウントで再試行できます。

```powershell
cx --auto-next exec "この変更を実装して"
```

検出対象は `rate limit`, `429`, `too many requests`, `quota exceeded`, `usage limit` などの出力です。対話 UI の途中で表示されるレートリミットは外側のプロセスから確実に検出できないため、その場合は `cx pick` または `cx next` で切り替えてから再実行してください。

### `codex` コマンドとして使う

普段の入力を `cx` にしたくない場合は、シェル関数で `codex` を `cx` に寄せられます。

PowerShell:

```powershell
cx hook powershell
```

表示された関数を `$PROFILE` に追加すると、以後は次のように使えます。

```powershell
codex exec "作業内容"
cxa
```

Bash / zsh:

```sh
cx hook bash
```

## 保存場所

デフォルトでは次に保存します。

```text
~/.codex-accounts/
  state.json
  accounts/
    main/
      auth.json
      config.toml
    sub/
      auth.json
      config.toml
```

保存先は `CODEX_ACCOUNTS_HOME` で変更できます。

```powershell
$env:CODEX_ACCOUNTS_HOME = "D:\codex-accounts"
```

ネイティブ `codex` の場所は通常 PATH から解決します。必要なら `CODEX_ACCOUNTS_CODEX_BIN` で固定できます。

## コマンド一覧

```text
cx login <account> [-- <codex login args>]
cx import <account> [--source <dir>] [--overwrite]
cx list
cx limits
cx gui
cx statusline
cx use <account>
cx current
cx next
cx pick
cx shell
cx tui
cx limit [account]
cx unlimit [account]
cx status [account]
cx [-a <account>] [--auto-next] [codex args...]
cx where
cx remove <account> --yes
```
