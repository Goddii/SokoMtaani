# Pipeline Templates Reference

Collection of CI/CD pipeline templates for common scenarios.

---

## GitHub Actions: Node.js Service

```yaml
# .github/workflows/node-service.yml
name: Node.js Service CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run test:integration
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/test

  security:
    runs-on: ubuntu-latest
    needs: lint-and-test
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level high
      - run: npx semgrep --config auto --error

  build:
    runs-on: ubuntu-latest
    needs: security
    if: github.event_name == 'push'
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          labels: ${{ steps.meta.outputs.labels }}

  deploy-staging:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    environment: staging
    steps:
      - uses: azure/setup-helm@v3
      - run: helm upgrade --install myapp ./helm --set image.tag=${{ github.sha }} --set environment=staging
        env:
          KUBECONFIG: ${{ secrets.STAGING_KUBECONFIG }}

  deploy-production:
    runs-on: ubuntu-latest
    needs: deploy-staging
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - uses: azure/setup-helm@v3
      - run: helm upgrade --install myapp ./helm --set image.tag=${{ github.sha }} --set environment=production --set replicaCount=3
        env:
          KUBECONFIG: ${{ secrets.PROD_KUBECONFIG }}
      - run: ./scripts/health-check.sh production
```

---

## GitHub Actions: Python Service

```yaml
# .github/workflows/python-service.yml
name: Python Service CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ['3.10', '3.11', '3.12']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: pip install -r requirements.txt
      - run: pip install -r requirements-dev.txt
      - run: pytest --cov=app --cov-report=xml
      - run: flake8 app/
      - run: mypy app/
      - uses: codecov/codecov-action@v3

  security:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - run: pip-audit
      - run: safety check -r requirements.txt

  build-and-deploy:
    runs-on: ubuntu-latest
    needs: security
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE }}
          aws-region: us-east-1
      - run: aws ecs update-service --cluster mycluster --service myservice --force-new-deployment
```

---

## GitLab CI: Multi-Stage

```yaml
# .gitlab-ci.yml
stages:
  - lint
  - test
  - security
  - build
  - deploy-staging
  - deploy-production

variables:
  DOCKER_DRIVER: overlay2
  IMAGE_TAG: $CI_COMMIT_SHA

.lint:
  stage: lint
  image: node:20
  script:
    - npm ci
    - npm run lint

.unit-test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm test
  artifacts:
    reports:
      junit: test-results.xml

.integration-test:
  stage: test
  image: node:20
  services:
    - postgres:15
  variables:
    DATABASE_URL: postgres://test:test@postgres:5432/test
  script:
    - npm ci
    - npm run test:integration

.security-scan:
  stage: security
  image: returntocorp/semgrep
  script:
    - semgrep --config auto --error

.build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$IMAGE_TAG .
    - docker push $CI_REGISTRY_IMAGE:$IMAGE_TAG
  only:
    - main

.deploy-staging:
  stage: deploy-staging
  image: bitnami/kubectl
  script:
    - kubectl set image deployment/myapp myapp=$CI_REGISTRY_IMAGE:$IMAGE_TAG -n staging
    - kubectl rollout status deployment/myapp -n staging
  only:
    - main
  environment:
    name: staging

.deploy-production:
  stage: deploy-production
  image: bitnami/kubectl
  script:
    - kubectl set image deployment/myapp myapp=$CI_REGISTRY_IMAGE:$IMAGE_TAG -n production
    - kubectl rollout status deployment/myapp -n production
  when: manual
  only:
    - main
  environment:
    name: production
```

---

## Jenkins Pipeline (Declarative)

```groovy
// Jenkinsfile
pipeline {
    agent { label 'linux' }

    environment {
        REGISTRY = 'registry.example.com'
        IMAGE = "${REGISTRY}/myapp"
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Lint') {
            steps {
                sh 'npm ci && npm run lint'
            }
        }

        stage('Test') {
            parallel {
                stage('Unit') {
                    steps { sh 'npm test -- --coverage' }
                }
                stage('Integration') {
                    agent { label 'docker' }
                    steps {
                        sh 'docker-compose -f test/docker-compose.yml up -d postgres'
                        sh 'npm run test:integration'
                    }
                }
            }
        }

        stage('Security') {
            steps {
                sh 'npm audit --audit-level high'
                sh 'npx semgrep --config auto --error'
            }
        }

        stage('Build') {
            steps {
                script {
                    docker.withRegistry(REGISTRY, 'jenkins-credentials') {
                        def img = docker.build("${IMAGE}:${env.BUILD_NUMBER}")
                        img.push()
                    }
                }
            }
        }

        stage('Deploy Staging') {
            when { branch 'main' }
            steps {
                sh 'kubectl set image deployment/myapp myapp=${IMAGE}:${env.BUILD_NUMBER} -n staging'
                sh 'kubectl rollout status deployment/myapp -n staging'
            }
        }

        stage('Deploy Production') {
            when { branch 'main' }
            steps {
                input message: 'Deploy to production?', ok: 'Deploy'
                sh 'kubectl set image deployment/myapp myapp=${IMAGE}:${env.BUILD_NUMBER} -n production'
                sh 'kubectl rollout status deployment/myapp -n production'
            }
        }
    }

    post {
        failure { sh './scripts/notify-failure.sh' }
        success { sh './scripts/notify-success.sh' }
    }
}
```

---

## Reverse Proxy / Ingress Template (Kubernetes)

```yaml
# ingress-template.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-XSS-Protection "1; mode=block" always;
spec:
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-service
                port:
                  number: 80
```

---

## Terraform: VPC Basics

```hcl
# infra/modules/vpc/main.tf
resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = var.name
    Environment = var.environment
  }
}

resource "aws_subnet" "public" {
  count             = length(var.public_subnet_cidr_blocks)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidr_blocks[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${count.index + 1}"
    Type = "public"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidr_blocks)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidr_blocks[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "${var.name}-private-${count.index + 1}"
    Type = "private"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = { Name = "${var.name}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags = { Name = "${var.name}-public-rt" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count          = length(var.public_subnet_cidr_blocks)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
```
