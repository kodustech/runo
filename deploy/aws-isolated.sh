#!/usr/bin/env bash
set -euo pipefail
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export AWS_PROFILE=kodus-devops-agent AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2
exec aws --profile kodus-devops-agent --region us-east-2 "$@"
