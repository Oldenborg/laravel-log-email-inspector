# Laravel Log Email Inspector

A small inbox-style viewer for emails that a Laravel app writes to its log with the `log` mail driver. Instead of scrolling through `laravel.log`, you get a list of messages with rendered HTML, plain text, headers, attachments and raw source.

It also has a **Templates** view that lists the mail Blade templates of the Laravel app the log belongs to, with a rendered preview, their source and the Mailable/Notification classes that use them.

The preview is rendered entirely inside this project — nothing is executed in the Laravel app. A small Blade approximation resolves directives (`@if` keeps its first branch, loops render once), replaces `{{ $var }}` echoes with `{var}` placeholder tokens, and renders markdown templates (`<x-mail::message>`, button, panel, subcopy, table) with a replica of Laravel's default mail theme. The app name in the theme header comes from the Laravel app's `.env` (`APP_NAME`).

## Requirements

- Node.js 20.12 or newer (uses the built-in `process.loadEnvFile()`)
- A Laravel app with `MAIL_MAILER=log`

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `LOG_PATH` to your Laravel log file:

```env
LOG_PATH=/path/to/your-laravel-app/storage/logs/laravel.log
PORT=4321
```

## Usage

```sh
npm start
```

The inspector opens http://localhost:4321 in your browser automatically (set `OPEN=false` to disable).

Send an email from your Laravel app (password reset, notification, etc.) and reload the page. The log is re-parsed whenever the file changes.

## Configuration

| Variable       | Required | Default | Description                                                             |
| -------------- | -------- | ------- | ----------------------------------------------------------------------- |
| `LOG_PATH`     | yes      | none    | Absolute path to the Laravel log file                                   |
| `PORT`         | no       | `4321`  | Port the inspector listens on                                           |
| `LARAVEL_PATH` | no       | derived | Laravel app root for the Templates view (derived from `LOG_PATH` by stripping `/storage/…`) |
| `OPEN`         | no       | `true`  | Set to `false` to not open the browser on start                         |

Variables set in your shell override `.env`:

```sh
LOG_PATH=/other/laravel.log PORT=5000 npm start
```

## How it works

- Laravel's `log` mail driver writes each message to the log as a raw RFC822 email.
- The server splits the log into entries, keeps the ones that look like emails, and parses them with [mailparser](https://nodemailer.com/extras/mailparser/).
- Inline `cid:` images are converted to data URIs so the HTML view looks like it would in a mail client.

### API

| Endpoint                 | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `GET /api/emails`        | Summary list of all emails, newest first                           |
| `GET /api/emails/:id`    | Full email: text, HTML, headers and raw source                     |
| `GET /api/templates`     | Mail Blade templates of the Laravel app, with referencing classes  |
| `GET /api/templates/:id` | Template source, rendered preview, and the source of each Mailable/Notification using it |

### How templates are found

A Blade file under `resources/views` counts as a mail template when any of these hold:

- it lives in a `mail`, `mails`, `email` or `emails` directory,
- it uses mail components (`<x-mail::…>` or `@component('mail::…')`),
- it is referenced by a class in `app/Mail` or `app/Notifications` via `view()`, `markdown()`, `text()`, `html()` or the `Content` named arguments.

Published vendor templates (`resources/views/vendor/…`) are always ignored.

## Privacy

Your Laravel log can contain real emails, reset links and personal data. The inspector only reads the file and serves it on localhost. Don't expose the port publicly, and don't commit logs or screenshots of real emails. `.env` is gitignored, so your local paths stay out of the repo.
