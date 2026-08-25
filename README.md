# Preço Real

Leilão de imóveis no Brasil: quanto o lote vale de verdade — calculado sobre
escrituras reais (ITBI), não sobre a avaliação do banco. Grátis, sem cadastro.

Этот репозиторий — публичная витрина проекта: payload с данными, фронт и два
скрипта сборки. GitHub Actions собирает ~7 000 статических страниц и публикует
их в Pages (`.github/workflows/pages.yml`; сборка ждёт переменную `SITE_URL`).

Сборка локально:

```
python proto_build.py          # payload -> site/v2/index.html
python serve.py --port 8899 &  # дев-сервер
python prerender.py --site https://example.invalid   # -> dist/
```

Данные обновляются пересчётом в основном (приватном) репозитории и приезжают
сюда готовыми JSON.
