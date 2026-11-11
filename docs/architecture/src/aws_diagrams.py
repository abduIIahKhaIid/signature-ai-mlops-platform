"""SignatureAI architecture diagrams with official AWS icons (mingrammer "diagrams" library).

    pip install diagrams          # also needs Graphviz:  winget install graphviz  /  apt install graphviz
    python docs/architecture/src/make_icons.py      # only once: generic icons for non-AWS services
    python docs/architecture/src/aws_diagrams.py    # writes docs/architecture/aws/*.png

Diagrams (the main picture, aws_architecture.png, is drawn by aws_architecture_svg.py):
    aws_iam_access.png     which identity (role / IAM user) may do what on which AWS resource
    aws_flows.png          the two automated flows: code deploy (CI/CD) and model retraining (continuous training)
"""
from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import EC2Instance, ECR
from diagrams.aws.management import SystemsManagerRunCommand
from diagrams.aws.security import IAMRole, IdentityAndAccessManagementIamLongTermSecurityCredential as IAMUser
from diagrams.aws.security import SecretsManager
from diagrams.aws.storage import SimpleStorageServiceS3Bucket as S3Bucket
from diagrams.custom import Custom
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.queue import Celery
from diagrams.onprem.vcs import Github
from diagrams.programming.framework import FastAPI

SRC = Path(__file__).resolve().parent
ICONS = SRC / "icons"
OUT = SRC.parent / "aws"

# colours of the three kinds of arrows (same legend as the other diagrams in docs/architecture)
SERVE = "#232F3E"     # request / model loading
TRAIN = "#1B7F5F"     # continuous training
DEPLOY = "#3B48CC"    # code deploy
IAMC = "#BF0816"      # permissions

GRAPH = {"fontsize": "26", "fontname": "Helvetica-Bold", "pad": "0.6", "nodesep": "0.7", "ranksep": "1.1",
         "splines": "spline", "bgcolor": "white", "labelloc": "t"}
NODE = {"fontsize": "13", "fontname": "Helvetica"}
EDGE = {"fontsize": "11", "fontname": "Helvetica"}

AWS_CLOUD = {"bgcolor": "#F2F8FD", "pencolor": "#232F3E", "fontsize": "16", "fontname": "Helvetica-Bold",
             "style": "rounded", "penwidth": "2"}
VPC = {"bgcolor": "#EEF7EE", "pencolor": "#7AA116", "fontsize": "14", "fontname": "Helvetica-Bold", "style": "dashed"}
EC2BOX = {"bgcolor": "#FFF6EC", "pencolor": "#ED7100", "fontsize": "14", "fontname": "Helvetica-Bold", "style": "rounded"}
EXT = {"bgcolor": "#F7F7F9", "pencolor": "#9AA0AA", "fontsize": "14", "fontname": "Helvetica-Bold", "style": "rounded"}
IAMBOX = {"bgcolor": "#FDF1F1", "pencolor": "#BF0816", "fontsize": "14", "fontname": "Helvetica-Bold", "style": "rounded"}


def icon(name: str) -> str:
    return str(ICONS / f"{name}.png")


def e(label="", color=SERVE, style="solid", **kw) -> Edge:
    return Edge(label=label, color=color, style=style, fontcolor=color, penwidth="1.8", **kw)


# --------------------------------------------------------------------------- 2. IAM access map
def iam_access():
    with Diagram("SignatureAI — IAM: who can do what", filename=str(OUT / "aws_iam_access"), outformat="png",
                 show=False, direction="LR", graph_attr={**GRAPH, "ranksep": "2.2"}, node_attr=NODE, edge_attr=EDGE):
        with Cluster("Who", graph_attr=EXT):
            ec2 = EC2Instance("EC2 server\n(containers via IMDS, hop limit 2)")
            gha = GithubActions("GitHub Actions")
            notebooks = Custom("Colab / Kaggle notebooks", icon("gpu"))

        with Cluster("IAM identities (account <ACCOUNT_ID>)", graph_attr=IAMBOX):
            role = IAMRole("role SignatureAI-EC2-Role\n+ SignatureAI-EC2-ReadModels\n+ AmazonSSMManagedInstanceCore")
            deployer = IAMUser("user signatureai-github-deployer\n+ SignatureAI-GitHub-Deploy")
            nbuser = IAMUser("user signatureai-colab-uploader\n+ SignatureAI-Notebook-S3")

        with Cluster("AWS resources", graph_attr=AWS_CLOUD):
            s3 = S3Bucket("S3 <BUCKET>\nsignatureai/detection/*\nsignatureai/similarity/*")
            ecr = ECR("ECR repository\nsignatureai")
            secret = SecretsManager("secret\nsignatureai/prod/dotenv")
            ssm = SystemsManagerRunCommand("SSM Run Command\non ONE instance")

        ec2 >> e("instance profile", IAMC) >> role
        gha >> e("access key (GitHub secrets)", IAMC) >> deployer
        notebooks >> e("access key (Colab / Kaggle secrets)", IAMC) >> nbuser

        role >> e("Get + List models\nPut aliases/* · control/*", SERVE) >> s3
        role >> e("pull", SERVE) >> ecr
        role >> e("GetSecretValue", SERVE) >> secret
        role >> e("SSM agent (managed policy)", SERVE) >> ssm
        deployer >> e("SendCommand + read result", DEPLOY) >> ssm
        deployer >> e("push", DEPLOY) >> ecr
        nbuser >> e("Get + Put + List\n(no Delete)", TRAIN) >> s3


# --------------------------------------------------------------------------- 3. the two automated flows
def flows():
    with Diagram("SignatureAI — the two automated flows", filename=str(OUT / "aws_flows"), outformat="png",
                 show=False, direction="LR", graph_attr={**GRAPH, "ranksep": "1.9"}, node_attr=NODE, edge_attr=EDGE):
        with Cluster("B · code deploy (CI/CD): git push → new code on EC2", graph_attr=EXT):
            dev = Github("1. git push main")
            ci = GithubActions("2. CI: pytest\nnode tests · web build\nmock pipeline")
            ecr = ECR("3. ECR images\napi/worker/pipeline\n-<commit>")
            ssm = SystemsManagerRunCommand("4. SSM Run Command\nremote_deploy.sh <sha>")
            sm = SecretsManager("5. .env from\nSecrets Manager")
            ec2 = EC2Instance("6. EC2: pull → up -d\n/health = <sha>\nelse automatic rollback")
            dev >> e("", DEPLOY) >> ci >> e("", DEPLOY) >> ecr >> e("", DEPLOY) >> ssm \
                >> e("", DEPLOY) >> sm >> e("", DEPLOY) >> ec2

        with Cluster("A · continuous training: new dataset ZIP → new model served", graph_attr=EXT):
            hf = Custom("1. ZIP uploaded to\nHugging Face", icon("dataset"))
            api = FastAPI("2. EC2 api\nPOST /webhooks/\nhuggingface")
            pipe = Celery("3. pipeline worker\nnew SHA-256?\npush Kaggle job")
            kg = Custom("4. Kaggle T4\nclean → fine-tune\n→ test → gate", icon("gpu"))
            comet = Custom("Comet\nmetrics", icon("tracking"))
            s3 = S3Bucket("5. S3 versions/<v>\nalias production\n(only if gate passed)")
            worker = Celery("6. workers hot-reload\nthe new model")
            hf >> e("", TRAIN) >> api >> e("", TRAIN) >> pipe >> e("", TRAIN) >> kg >> e("", TRAIN) >> s3 \
                >> e("", TRAIN) >> worker
            kg >> e("", TRAIN, style="dashed") >> comet


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    iam_access()
    flows()
    for p in sorted(OUT.glob("*.png")):
        print("wrote", p)
