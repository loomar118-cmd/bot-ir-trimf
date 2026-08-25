#!/bin/bash
# Diagnostic du bot IR-TRIMF : etat du webhook Telegram et du service Render.
# Usage : bash etat.sh
cd "$(dirname "$0")"
T=$(grep -m1 'TELEGRAM_TOKEN' .env | cut -d= -f2)

echo '--- SERVICE RENDER ---'
curl -s -o /dev/null -w 'GET /  -> %{http_code}  en %{time_total}s\n' https://bot-ir-trimf.onrender.com/

echo '--- WEBHOOK TELEGRAM ---'
curl -s "https://api.telegram.org/bot$T/getWebhookInfo" | /usr/bin/python3 -c "
import sys, json
d = json.load(sys.stdin)['result']
for k in ['url','pending_update_count','last_error_message','last_error_date','ip_address']:
    print(f'{k:22s} : {d.get(k, \"(aucun)\")}')
"
