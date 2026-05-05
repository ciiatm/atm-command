output "app_url" {
  description = "Public HTTPS URL of the ATM Command application"
  value       = "https://${var.domain_name}"
}

output "alb_dns_name" {
  description = "ALB DNS name (useful before your domain propagates)"
  value       = aws_lb.app.dns_name
}

output "ec2_public_ip" {
  description = "EC2 instance public IP address"
  value       = aws_instance.app.public_ip
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ubuntu@${aws_instance.app.public_ip}"
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (private, only reachable from EC2)"
  value       = aws_db_instance.postgres.endpoint
}

output "database_url" {
  description = "Full DATABASE_URL connection string"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}"
  sensitive   = true
}

output "setup_log" {
  description = "Check this file on EC2 if the app isn't responding after deploy"
  value       = "ssh into the instance and run: sudo tail -f /var/log/atm-command-setup.log"
}
