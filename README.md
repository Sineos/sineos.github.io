
# sineos.github.io

This web-page uses the logic of Klipper's [graphstats.py](https://github.com/Klipper3d/klipper/blob/master/scripts/graphstats.py) to analyze a `klippy.log` and display the results in graphs. This is a direct transformation of the Python script and thus based on the original work of Kevin O'Connor.

### Limitations
* Purely created for myself to speed up analyzing logs
* No error handling. If you supply a corrupted / modified klippy.log, simply no graph will appear (check browser's developer console)
* Zooming one graph does not synchronize the others (couldn't get this working reliably)
* Ugly. I'm not good at HTML, nor do I like it ¯\\\_(ツ)_/¯

Feedback or improvements are always welcome.
