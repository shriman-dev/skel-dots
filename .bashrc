#
# ~/.bashrc
#
# Source global definations
if [[ -f /etc/bashrc ]]; then
    source /etc/bashrc
fi

# User specific environment
if [[ -d ~/.shell.d ]]; then
	for rc in ~/.shell.d/*; do
		if [[ -f "${rc}" ]]; then
			. "${rc}"
		fi
	done
fi

unset rc

