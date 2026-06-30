#!/usr/bin/env bash
#
# Ensure ONLY your current public IP can SSH to the instance — handles rotating
# residential IPs. Adds the current IP and prunes any other port-22 /32 rules.
# Best-effort: never aborts the caller (so a deploy still proceeds on AWS hiccups).
#
set -uo pipefail
cd "$(dirname "$0")"
source ./instance.env

MYIP=$(curl -s --max-time 8 https://checkip.amazonaws.com | tr -d '[:space:]')
if [ -z "$MYIP" ]; then echo "whitelist: could not detect public IP (skipping)" >&2; exit 0; fi

aws ec2 authorize-security-group-ingress --group-id "$WA_SG" --protocol tcp --port 22 \
  --cidr "$MYIP/32" --region "$WA_REGION" --profile "$WA_PROFILE" >/dev/null 2>&1 || true
echo "whitelist: SSH allowed from $MYIP/32"

# Prune any other /32 SSH rules so only the current IP remains.
for cidr in $(aws ec2 describe-security-groups --group-ids "$WA_SG" --region "$WA_REGION" --profile "$WA_PROFILE" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' --output text 2>/dev/null); do
  if [ "$cidr" != "$MYIP/32" ]; then
    aws ec2 revoke-security-group-ingress --group-id "$WA_SG" --protocol tcp --port 22 \
      --cidr "$cidr" --region "$WA_REGION" --profile "$WA_PROFILE" >/dev/null 2>&1 || true
    echo "whitelist: revoked stale $cidr"
  fi
done
exit 0
