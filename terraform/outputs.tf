output "app_url" {
  description = "Public URL of the ATM Command application"
  value       = "http://${aws_instance.app.public_ip}:${var.app_port}"
}

output "ec2_public_ip" {
  description = "EC2 instance public IP address"
  value       = aws_instance.app.public_ip
}

output "ec2_public_dns" {
  description = "EC2 instance public DNS name"
  value       = aws_instance.app.public_dns
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ubuntu@${aws_instance.app.public_ip}"
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.postgres.endpoint
  sensitive   = false
}

output "database_url" {
  description = "Full DATABASE_URL connection string"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}"
  sensitive   = true
}
