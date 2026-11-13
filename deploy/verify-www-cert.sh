#!/bin/bash
# Verify the expanded regimend.app cert + www serving.
echo | openssl s_client -connect regimend.app:443 -servername www.regimend.app 2>/dev/null | openssl x509 -noout -ext subjectAltName
curl -sS -o /dev/null -w 'www https login: %{http_code}\n' https://www.regimend.app/login
curl -sS -o /dev/null -w 'apex https login: %{http_code}\n' https://regimend.app/login
