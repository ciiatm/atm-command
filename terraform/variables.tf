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
  description = "Port the Node.js server listens on"
  type        = number
  default     = 3000
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into the EC2 instance"
  type        = string
  default     = "0.0.0.0/0"
}
