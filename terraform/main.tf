terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

# ALB: accepts public HTTP/HTTPS traffic
resource "aws_security_group" "alb" {
  name        = "${var.app_name}-alb-sg"
  description = "ATM Command load balancer - public HTTP/HTTPS"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.app_name}-alb-sg"
  }
}

# EC2: accepts app traffic only from the ALB, plus SSH from allowed CIDR
resource "aws_security_group" "app" {
  name        = "${var.app_name}-app-sg"
  description = "ATM Command app server - accepts traffic from ALB and SSH"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  ingress {
    description     = "App port from ALB only"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.app_name}-app-sg"
  }
}

# RDS: accepts Postgres only from the EC2 app server
resource "aws_security_group" "rds" {
  name        = "${var.app_name}-rds-sg"
  description = "ATM Command RDS PostgreSQL - accessible from app server only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL from app server"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.app_name}-rds-sg"
  }
}

# ---------------------------------------------------------------------------
# ACM certificate (DNS-validated via Route 53)
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "app" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.app_name}-cert"
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.app_name}-db-subnet-group"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Name = "${var.app_name}-db-subnet-group"
  }
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.app_name}-db"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = var.db_name
  username                = var.db_username
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.postgres.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0
  multi_az                = false

  tags = {
    Name = "${var.app_name}-db"
  }
}

# ---------------------------------------------------------------------------
# EC2 instance
# ---------------------------------------------------------------------------

locals {
  database_url = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_pair_name
  vpc_security_group_ids = [aws_security_group.app.id]
  subnet_id              = tolist(data.aws_subnets.default.ids)[0]

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = <<-USERDATA
    #!/usr/bin/env bash
    set -euo pipefail
    exec > /var/log/atm-command-setup.log 2>&1

    echo "==> [1/7] Installing system packages..."
    apt-get update -y
    apt-get install -y git curl build-essential

    echo "==> [2/7] Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs

    echo "==> [3/7] Installing pnpm..."
    npm install -g pnpm

    echo "==> [4/7] Cloning repo..."
    git clone --branch ${var.github_branch} ${var.github_repo_url} /opt/atm-command
    chown -R ubuntu:ubuntu /opt/atm-command
    cd /opt/atm-command

    echo "==> [5/7] Building..."
    ./build.sh

    echo "==> [6/7] Writing env file and pushing DB schema..."
    printf 'DATABASE_URL=%s\nPORT=%s\nNODE_ENV=production\n' \
      "${local.database_url}" \
      "${var.app_port}" \
      > /opt/atm-command/.env

    export DATABASE_URL="${local.database_url}"
    export PORT="${var.app_port}"
    export NODE_ENV="production"

    for i in 1 2 3 4 5; do
      echo "DB schema push attempt $i/5..."
      pnpm --filter @workspace/db run push-force < /dev/null && break || true
      [ "$i" -eq 5 ] && echo "WARNING: DB push failed after 5 attempts, continuing..." || sleep 15
    done

    echo "==> [7/7] Creating systemd service and starting app..."
    NODE_BIN=$(which node)

    printf '%s\n' \
      '[Unit]' \
      'Description=ATM Command Node.js Server' \
      'After=network.target' \
      '' \
      '[Service]' \
      'Type=simple' \
      'User=ubuntu' \
      'WorkingDirectory=/opt/atm-command' \
      "ExecStart=$NODE_BIN --enable-source-maps /opt/atm-command/artifacts/api-server/dist/index.mjs" \
      'Restart=always' \
      'RestartSec=5' \
      'Environment=NODE_ENV=production' \
      "Environment=PORT=${var.app_port}" \
      "Environment=DATABASE_URL=${local.database_url}" \
      '' \
      '[Install]' \
      'WantedBy=multi-user.target' \
      > /etc/systemd/system/atm-command.service

    systemctl daemon-reload
    systemctl enable atm-command
    systemctl start atm-command

    echo "==> Allowing ubuntu to restart the service without sudo password..."
    echo "ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart atm-command, /bin/systemctl status atm-command" \
      > /etc/sudoers.d/atm-command
    chmod 440 /etc/sudoers.d/atm-command

    echo "==> Done. Service status:"
    systemctl status atm-command --no-pager || true

    echo "ATM Command deployed successfully"
  USERDATA

  tags = {
    Name = "${var.app_name}-server"
  }

  depends_on = [aws_db_instance.postgres]
}

# ---------------------------------------------------------------------------
# Application Load Balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "app" {
  name               = "${var.app_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = {
    Name = "${var.app_name}-alb"
  }
}

resource "aws_lb_target_group" "app" {
  name     = "${var.app_name}-tg"
  port     = var.app_port
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  health_check {
    path                = "/api/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "${var.app_name}-tg"
  }
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}

# HTTP to HTTPS redirect
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS listener - terminates TLS, forwards to EC2
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------------------
# Route 53 - point your domain at the ALB
# ---------------------------------------------------------------------------

resource "aws_route53_record" "app" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# Elastic IP - stable public IP for SSH / GitHub Actions deploys
# ---------------------------------------------------------------------------

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "${var.app_name}-eip"
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "ec2_public_ip" {
  description = "Elastic IP of the EC2 instance — use this as EC2_HOST in GitHub secrets"
  value       = aws_eip.app.public_ip
}

output "app_url" {
  description = "Public HTTPS URL of the application"
  value       = "https://${var.domain_name}"
}

output "alb_dns" {
  description = "ALB DNS name"
  value       = aws_lb.app.dns_name
}
