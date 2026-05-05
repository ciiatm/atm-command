aws_region      = "us-east-1"
app_name        = "atm-command"

# Your GitHub repo (must be public, or embed a token: https://TOKEN@github.com/...)
github_repo_url = "https://github.com/ciiatm/atm-command.git"
github_branch   = "main"

# An existing EC2 Key Pair name in your AWS account (for SSH access)
key_pair_name   = "replit"

# Instance sizing
instance_type     = "t3.small"
db_instance_class = "db.t3.micro"

# Database credentials
db_name     = "atm_command"
db_username = "rishmawia1"
db_password = "6128AmR!"   # use a strong password

# HTTPS / domain
# domain_name must be a subdomain (or apex) inside the Route 53 zone below
domain_name     = "atm.ciiatm.com"
route53_zone_id = "Z090355634R6QTTSUCUDZ"   # find this in Route 53 → Hosted zones

# Restrict SSH to your office IP for production
allowed_ssh_cidr = "0.0.0.0/0"
