#!/usr/bin/env bash
# No fallback to default or credentials inherited from another session.
set -euo pipefail
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export AWS_PROFILE=kodus-devops-agent
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2
arn=$(aws sts get-caller-identity --region us-east-2 --query Arn --output text)
if [[ "$arn" != "arn:aws:iam::611816806956:user/kodus-devops-agent" ]]; then
  echo "Refusing to deploy: wrong AWS identity ($arn)" >&2
  exit 1
fi
aws ec2 describe-vpcs --region us-east-2 --query 'Vpcs[].{Id:VpcId,Default:IsDefault}' --output json
