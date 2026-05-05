variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name, used for resource naming"
  type        = string
  default     = "atm-command"
}

variable "github_repo_url" {
  description = "HTTPS URL of your GitHub repo (e.g. https://github.com/yourname/atm-command.git)"
  type        = string
}

variable "github_branch" {
  description = "Branch to deploy"
  type        = string
  default     = "main"
}

variable "key_pair_name" {
  description = "Name of an existing EC2 Key Pair for SSH access"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "atm_command"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  default     = "atm_admin"
}

variable "db_password" {
  description = "PostgreSQL master password (min 8 chars)"
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "app_port" {
  description = "Internal port the Node.js server listens on (not exposed publicly — traffic comes through the ALB)"
  type        = number
  default     = 3000
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into the EC2 instance. Restrict to your IP in production."
  type        = string
  default     = "0.0.0.0/0"
}

variable "domain_name" {
  description = "Fully-qualified domain name for the app (e.g. atm.yourcompany.com). Must be in the Route 53 zone below."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID that owns domain_name. Used for ACM DNS validation and the ALB alias record."
  type        = string
}
