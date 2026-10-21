# Setup Ubuntu Bootstrap Environment
PWD=$(pwd)

sudo debootstrap \
  --arch=amd64 \
  --variant=minbase \
  --include=bash,coreutils,findutils,grep,sed,gawk,tar,gzip,xz-utils,passwd,login,sudo,ca-certificates,locales,procps,iproute2,iputils-ping,util-linux \
  noble \
  "$PWD/system" \
  https://archive.ubuntu.com/ubuntu/